import { Plugin, MarkdownView, TFile, TFolder, PluginSettingTab, App, Setting, Notice, ItemView, WorkspaceLeaf } from 'obsidian';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { yCollab } from 'y-codemirror.next';
import { Compartment, Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

interface CoSyncSettings {
  serverUrl: string;
  token: string;
  workspaceId: string;
  connectionCode: string;
  syncHashes: Record<string, string>;
  syncVersions: Record<string, number>;
  fileMappings: Record<string, string>;
  displayName: string;
  showManualSettings: boolean;
  syncInterval: number;
  enableBackgroundSync: boolean;
  syncConfig: boolean;
  deletedFilesQueue?: string[];
}

const DEFAULT_SETTINGS: CoSyncSettings = {
  serverUrl: 'https://cosync.domain',
  token: '',
  workspaceId: 'ws-default',
  connectionCode: '',
  syncHashes: {},
  syncVersions: {},
  fileMappings: {},
  displayName: 'User',
  showManualSettings: false,
  syncInterval: 10,
  enableBackgroundSync: true,
  syncConfig: false,
  deletedFilesQueue: []
};

const SYNCABLE_EXTENSIONS = new Set(['md', 'txt']);

function getDeterministicColor(name: string): string {
  const colors = ['#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#06b6d4', '#f43f5e'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

class CoSyncPlugin extends Plugin {
  settings!: CoSyncSettings;
  
  // Collaborative state variables
  private ydoc: Y.Doc | null = null;
  public wsProvider: WebsocketProvider | null = null;
  private activeFile: TFile | null = null;
  private activeDocumentId: string | null = null;
  
  // Safeguard flag to avoid infinite update loops
  private isApplyingRemoteUpdate = false;
  // Programmatic modifications tracker to prevent loopbacks from vault.modify events
  private programmedModifications: Set<string> = new Set();

  private addProgrammedModification(path: string) {
    const normalized = path.normalize('NFC');
    this.programmedModifications.add(normalized);
    setTimeout(() => {
      this.programmedModifications.delete(normalized);
    }, 3000); // Auto-expire after 3 seconds to prevent flags from staying dirty forever
  }

  private deleteProgrammedModification(path: string) {
    this.programmedModifications.delete(path.normalize('NFC'));
  }

  private hasProgrammedModification(path: string): boolean {
    return this.programmedModifications.has(path.normalize('NFC'));
  }

  private getUniqueFilePath(path: string): string {
    const dotIndex = path.lastIndexOf('.');
    const base = dotIndex !== -1 ? path.substring(0, dotIndex) : path;
    const ext = dotIndex !== -1 ? path.substring(dotIndex + 1) : '';
    let counter = 1;
    let uniquePath = path;
    while (
      this.settings.fileMappings[uniquePath] ||
      this.app.vault.getAbstractFileByPath(uniquePath)
    ) {
      uniquePath = ext ? `${base} ${counter}.${ext}` : `${base} ${counter}`;
      counter++;
    }
    return uniquePath;
  }

  private currentSyncRunEvents: string[] | null = null;

  private updateSidebarViews() {
    const leaves = this.app.workspace.getLeavesOfType(COSYNC_VIEW_TYPE);
    leaves.forEach(leaf => {
      if (leaf.view instanceof CoSyncView) {
        leaf.view.render();
      }
    });
  }

  private verifyActiveFileMapping() {
    if (!this.activeFile) return;
    const activePath = this.activeFile.path.normalize('NFC');
    const mappedId = this.settings.fileMappings[activePath];
    if (mappedId && mappedId !== this.activeDocumentId) {
      console.log(`CoSync: Active file document ID changed to ${mappedId}. Reconnecting...`);
      this.reconnect();
    }
  }

  // In-memory cache for server documents to optimize performance and prevent duplicate requests
  private serverDocsCache: Array<{ id: string; title: string; updatedAt: string; version: number }> | null = null;
  private serverDocsCacheTime = 0;
  private downloadedFilesCooldown: Map<string, number> = new Map();
  
  // CodeMirror 6 configuration compartment
  private yjsCompartment = new Compartment();

  private syncTimer: NodeJS.Timeout | null = null;
  private syncTimeout: NodeJS.Timeout | null = null;
  private instantSyncTimeout: ReturnType<typeof setTimeout> | null = null;
  private statusBarEl: HTMLElement | null = null;
  private currentStatus: 'connected' | 'connecting' | 'disconnected' | 'syncing' = 'disconnected';
  private isSyncing = false;
  private boundEditorView: EditorView | null = null;

  // Global Workspace WebSocket notifications connection
  private globalWs: WebSocket | null = null;
  private globalWsReconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private lastWsUrl: string = '';
  private lastWsToken: string = '';

  public recentLogs: Array<{ timestamp: string; level: 'info' | 'success' | 'warn' | 'error'; message: string }> = [];

  public logEvent(level: 'info' | 'success' | 'warn' | 'error', message: string) {
    const timestamp = new Date().toLocaleTimeString();
    this.recentLogs.unshift({ timestamp, level, message });
    if (this.recentLogs.length > 50) {
      this.recentLogs.pop();
    }
    console.log(`CoSync [${level.toUpperCase()}]: ${message}`);
    
    if (this.currentSyncRunEvents) {
      this.currentSyncRunEvents.push(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
    }
    
    // Update open sidebar views
    this.updateSidebarViews();
  }

  private updateStatusBar(status: 'connected' | 'connecting' | 'disconnected' | 'syncing', customText?: string) {
    this.currentStatus = status;
    if (!this.statusBarEl) return;
    
    this.statusBarEl.empty();
    
    const container = this.statusBarEl.createEl('div', { cls: 'cosync-status-bar' });
    container.style.display = 'flex';
    container.style.alignItems = 'center';
    container.style.gap = '6px';
    container.style.cursor = 'pointer';
    container.title = 'Obsidian CoSync Status';
    container.addEventListener('click', () => {
      this.activateView();
      this.syncEntireVault();
    });
    
    const dot = container.createEl('span', { cls: `cosync-status-dot status-${status}` });
    
    const text = container.createEl('span');
    text.style.fontSize = '12px';
    text.style.fontWeight = '500';
    
    if (status === 'connected') {
      text.textContent = customText || 'CoSync: Connected';
    } else if (status === 'connecting') {
      text.textContent = customText || 'CoSync: Connecting';
    } else if (status === 'disconnected') {
      text.textContent = customText || 'CoSync: Offline';
    } else if (status === 'syncing') {
      text.textContent = customText || 'CoSync: Syncing...';
    }

    // Refresh any open sidebar views
    const leaves = this.app.workspace.getLeavesOfType(COSYNC_VIEW_TYPE);
    leaves.forEach(leaf => {
      if (leaf.view instanceof CoSyncView) {
        leaf.view.render();
      }
    });
  }

  async onload() {
    this.logEvent('info', 'Loading Obsidian CoSync Plugin...');
    await this.loadSettings();
    this.connectGlobalWebSocket();

    // Register setting tab
    this.addSettingTab(new CoSyncSettingTab(this.app, this));

    // Register sidebar view
    this.registerView(
      COSYNC_VIEW_TYPE,
      (leaf) => new CoSyncView(leaf, this)
    );

    // Add ribbon icon to open/reveal sidebar
    this.addRibbonIcon('users', 'CoSync Collaboration', () => {
      this.activateView();
    });

    // Add command to show sidebar
    this.addCommand({
      id: 'show-cosync-sidebar',
      name: 'Show Collaboration Sidebar',
      callback: () => this.activateView()
    });



    // Add status bar item
    this.statusBarEl = this.addStatusBarItem();
    this.updateStatusBar('disconnected');

    // Register the dynamic CodeMirror 6 extension
    // We register an empty extension compartment initially
    this.registerEditorExtension(this.yjsCompartment.of([]));

    // Monitor note file switches
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => this.handleFileSwitch())
    );

    // Rebind Yjs when editor layout changes (e.g. view mode toggle)
    this.registerEvent(
      this.app.workspace.on('layout-change', () => this.bindYjsToEditor())
    );

    // Monitor file modifications to trigger instant sync
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file.path.startsWith('.')) return;
        if (file instanceof TFile) {
          const normalizedPath = file.path.normalize('NFC');
          if (normalizedPath === 'cosync-sync-log.md') return;
          if (this.hasProgrammedModification(normalizedPath)) {
            this.deleteProgrammedModification(normalizedPath);
            return;
          }
          if (this.isApplyingRemoteUpdate) return;
          if (this.instantSyncTimeout) clearTimeout(this.instantSyncTimeout);
          this.instantSyncTimeout = setTimeout(async () => {
            // 1. Process active note modification (if applicable)
            await this.handleExternalModification(file);

            // 2. Trigger background sync (skip if it is active markdown note being edited)
            const activeMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (activeMarkdownView && activeMarkdownView.file?.path.normalize('NFC') === normalizedPath) {
              return;
            }

            if (this.isSyncing) return;
            await this.syncVault();
          }, 1500); // 1.5 seconds pause debounce
        }
      })
    );

    // Monitor file creations to trigger instant sync
    this.registerEvent(
      this.app.vault.on('create', (file) => {
        const normalizedPath = file.path.normalize('NFC');
        if (normalizedPath.startsWith('.')) return;
        if (normalizedPath === 'cosync-sync-log.md') return;
        if (this.hasProgrammedModification(normalizedPath)) {
          this.deleteProgrammedModification(normalizedPath);
          return;
        }
        if (this.isApplyingRemoteUpdate) return;
        if (this.isSyncing) return;
        if (this.instantSyncTimeout) clearTimeout(this.instantSyncTimeout);
        this.instantSyncTimeout = setTimeout(() => this.syncVault(), 1500);
      })
    );

    // Monitor file deletions to trigger instant sync
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        const normalizedPath = file.path.normalize('NFC');
        if (normalizedPath.startsWith('.')) return;
        if (normalizedPath === 'cosync-sync-log.md') return;
        
        let isProgrammed = false;
        if (this.hasProgrammedModification(normalizedPath)) {
          this.deleteProgrammedModification(normalizedPath);
          isProgrammed = true;
        }
        if (this.isApplyingRemoteUpdate) {
          isProgrammed = true;
        }
        if (isProgrammed) return;

        if (!this.settings.deletedFilesQueue) {
          this.settings.deletedFilesQueue = [];
        }
        if (!this.settings.deletedFilesQueue.includes(normalizedPath)) {
          this.settings.deletedFilesQueue.push(normalizedPath);
          this.saveSettings();
        }

        if (this.isSyncing) return;
        if (this.instantSyncTimeout) clearTimeout(this.instantSyncTimeout);
        this.instantSyncTimeout = setTimeout(() => this.syncVault(), 1500);
      })
    );

    // Monitor file renames/moves to keep mappings up to date and trigger instant sync
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        const normalizedPath = file.path.normalize('NFC');
        const oldPathNormalized = oldPath.normalize('NFC');

        // Consume programmed modifications flags first
        let isProgrammed = false;
        if (this.hasProgrammedModification(normalizedPath)) {
          this.deleteProgrammedModification(normalizedPath);
          isProgrammed = true;
        }
        if (this.hasProgrammedModification(oldPathNormalized)) {
          this.deleteProgrammedModification(oldPathNormalized);
          isProgrammed = true;
        }
        if (isProgrammed) return;

        let changed = false;
        const renamesToSync: { docId: string; newPath: string }[] = [];

        if (file instanceof TFile) {
          if (this.settings.fileMappings?.[oldPathNormalized]) {
            const docId = this.settings.fileMappings[oldPathNormalized];
            this.settings.fileMappings[normalizedPath] = docId;
            delete this.settings.fileMappings[oldPathNormalized];
            changed = true;
            renamesToSync.push({ docId, newPath: normalizedPath });
          }
        } else if (file instanceof TFolder) {
          // A folder was renamed/moved. Recursively update all file mappings inside it.
          const oldPrefix = oldPathNormalized + '/';
          const newPrefix = normalizedPath + '/';
          
          if (this.settings.fileMappings) {
            for (const [path, docId] of Object.entries(this.settings.fileMappings)) {
              const pathNormalized = path.normalize('NFC');
              if (pathNormalized.startsWith(oldPrefix)) {
                const newPath = newPrefix + pathNormalized.substring(oldPrefix.length);
                this.settings.fileMappings[newPath] = docId;
                if (pathNormalized !== newPath) {
                  delete this.settings.fileMappings[path];
                }
                changed = true;
                renamesToSync.push({ docId, newPath });
              }
            }
          }
          // Note: syncHashes for attachments are not updated here.
          // By letting syncHashes keep the old attachment paths, the sync engine will
          // see them as deleted locally, delete them on the server, and upload them
          // under the new path, which prevents duplicate attachments on other devices.
        }

        if (changed) {
          this.saveSettings();
        }

        const triggerSync = () => {
          if (this.isApplyingRemoteUpdate) return;
          if (this.isSyncing) return;
          if (this.instantSyncTimeout) clearTimeout(this.instantSyncTimeout);
          this.instantSyncTimeout = setTimeout(() => this.syncVault(), 1500);
        };

        if (renamesToSync.length > 0) {
          Promise.all(
            renamesToSync.map(r => this.updateServerDocumentTitle(r.docId, r.newPath))
          ).then(() => {
            triggerSync();
          }).catch(err => {
            console.error('CoSync: Error updating server titles for renamed items:', err);
            triggerSync();
          });
        } else {
          triggerSync();
        }
      })
    );

    // Initial check when layout is fully loaded
    this.app.workspace.onLayoutReady(() => {
      this.handleFileSwitch();
    });

    // Start periodic background synchronization
    this.startPeriodicSync();
    // Also run once immediately on load
    setTimeout(() => this.syncVault(), 2000);
  }

  public startPeriodicSync() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    if (this.settings.enableBackgroundSync && this.settings.syncInterval > 0) {
      this.syncTimer = setInterval(() => this.syncVault(), this.settings.syncInterval * 1000);
    }
  }

  onunload() {
    console.log('Unloading CoSync Plugin...');
    this.disconnectGlobalWebSocket();
    this.disconnectActive();
    if (this.statusBarEl) {
      this.statusBarEl.remove();
      this.statusBarEl = null;
    }
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  /**
   * Shuts down previous WebSocket links and releases Y.Doc allocations.
   */
  // Global Workspace WebSocket notifications connection helper functions
  public connectGlobalWebSocket() {
    // Clear any existing reconnect timer
    if (this.globalWsReconnectTimeout) {
      clearTimeout(this.globalWsReconnectTimeout);
      this.globalWsReconnectTimeout = null;
    }

    if (!this.settings.serverUrl || !this.settings.token) {
      return;
    }

    const workspaceId = this.settings.workspaceId || 'default-workspace';
    const wsUrl = this.settings.serverUrl.replace(/^http/, 'ws') + `/workspace/${workspaceId}/global`;
    const wsToken = this.settings.token;

    // If already connecting or connected with same parameters, reuse it
    if (this.globalWs && 
        (this.globalWs.readyState === WebSocket.CONNECTING || this.globalWs.readyState === WebSocket.OPEN) &&
        wsUrl === this.lastWsUrl &&
        wsToken === this.lastWsToken) {
      return;
    }

    // Clean up previous socket listeners and close old socket to avoid leaks/multiplied events
    if (this.globalWs) {
      const oldWs = this.globalWs;
      this.globalWs = null;
      oldWs.onmessage = null;
      oldWs.onclose = null;
      oldWs.onerror = null;
      try { oldWs.close(); } catch (e) {}
    }

    this.lastWsUrl = wsUrl;
    this.lastWsToken = wsToken;
    this.logEvent('info', `Connecting to global sync notification channel...`);
    
    try {
      const socket = new WebSocket(wsUrl, ['co-sync-auth', wsToken]);
      this.globalWs = socket;

      socket.onmessage = (event) => {
        if (event.data === 'sync') {
          this.logEvent('info', 'Received global sync trigger. Syncing...');
          if (this.instantSyncTimeout) clearTimeout(this.instantSyncTimeout);
          this.instantSyncTimeout = setTimeout(() => {
            if (!this.isSyncing) {
              this.syncVault();
            }
          }, 500);
        }
      };

      socket.onclose = () => {
        // Only trigger reconnect if this is still the active socket instance
        if (this.globalWs === socket) {
          this.globalWs = null;
          this.globalWsReconnectTimeout = setTimeout(() => this.connectGlobalWebSocket(), 5000);
        }
      };

      socket.onerror = (err) => {
        console.warn('CoSync: Global notification WebSocket error:', err);
      };
    } catch (e) {
      console.warn('CoSync: Failed to establish global notification socket:', e);
    }
  }

  public disconnectGlobalWebSocket() {
    if (this.globalWsReconnectTimeout) {
      clearTimeout(this.globalWsReconnectTimeout);
      this.globalWsReconnectTimeout = null;
    }
    if (this.globalWs) {
      const ws = this.globalWs;
      this.globalWs = null; // prevent reconnect loop on close
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try { ws.close(); } catch (e) {}
    }
    this.lastWsUrl = '';
    this.lastWsToken = '';
  }

  /** Returns true for .excalidraw and .excalidraw.md files. These are text-based
   * (UTF-8 JSON) and must be treated as text by Obsidian APIs to avoid corruption. */
  private isExcalidrawFile(filePath: string): boolean {
    const lp = filePath.toLowerCase();
    return lp.endsWith('.excalidraw.md') || lp.endsWith('.excalidraw');
  }

  private async readLocalBinary(filePath: string): Promise<ArrayBuffer> {
    // .excalidraw.md files are plain text (UTF-8 JSON). Read as text and encode
    // to a stable UTF-8 buffer so the hash is consistent across platforms.
    if (!filePath.startsWith('.') && this.isExcalidrawFile(filePath)) {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (file instanceof TFile) {
        const text = await this.app.vault.read(file);
        return new TextEncoder().encode(text).buffer;
      }
      throw new Error(`File not found: ${filePath}`);
    }
    if (filePath.startsWith('.')) {
      return await this.app.vault.adapter.readBinary(filePath);
    } else {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (file instanceof TFile) {
        return await this.app.vault.readBinary(file);
      }
      throw new Error(`File not found: ${filePath}`);
    }
  }

  private async writeLocalBinary(filePath: string, data: ArrayBuffer): Promise<void> {
    // .excalidraw.md files must be written as text to avoid binary corruption in Obsidian.
    // This matches the LiveSync approach: isPlainText('.excalidraw.md') → true.
    if (!filePath.startsWith('.') && this.isExcalidrawFile(filePath)) {
      const text = new TextDecoder().decode(data);
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (file instanceof TFile) {
        await this.app.vault.modify(file, text);
      } else {
        // Ensure parent folders exist
        const parts = filePath.split('/');
        if (parts.length > 1) {
          let current = '';
          for (let i = 0; i < parts.length - 1; i++) {
            current = current ? `${current}/${parts[i]}` : parts[i];
            if (!this.app.vault.getAbstractFileByPath(current)) {
              await this.app.vault.createFolder(current);
            }
          }
        }
        await this.app.vault.create(filePath, text);
      }
      return;
    }
    if (filePath.startsWith('.')) {
      // Ensure parent folders exist
      const parts = filePath.split('/');
      if (parts.length > 1) {
        let current = '';
        for (let i = 0; i < parts.length - 1; i++) {
          current = current ? `${current}/${parts[i]}` : parts[i];
          if (!(await this.app.vault.adapter.exists(current))) {
            await this.app.vault.adapter.mkdir(current);
          }
        }
      }
      await this.app.vault.adapter.writeBinary(filePath, data);
    } else {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (file instanceof TFile) {
        await this.app.vault.modifyBinary(file, data);
      } else {
        // Ensure parent folders exist
        const parts = filePath.split('/');
        if (parts.length > 1) {
          let current = '';
          for (let i = 0; i < parts.length - 1; i++) {
            current = current ? `${current}/${parts[i]}` : parts[i];
            if (!this.app.vault.getAbstractFileByPath(current)) {
              await this.app.vault.createFolder(current);
            }
          }
        }
        await this.app.vault.createBinary(filePath, data);
      }
    }
  }

  private async deleteLocalFile(filePath: string, localFile?: TFile): Promise<void> {
    if (filePath.startsWith('.')) {
      if (await this.app.vault.adapter.exists(filePath)) {
        await this.app.vault.adapter.remove(filePath);
      }
    } else {
      const fileToDel = localFile || this.app.vault.getAbstractFileByPath(filePath);
      if (fileToDel instanceof TFile) {
        await this.app.vault.delete(fileToDel);
      }
    }
  }

  private async updateServerDocumentTitle(docId: string, newPath: string) {
    if (!this.settings.serverUrl || !this.settings.token || !this.settings.workspaceId) {
      return;
    }
    const isMarkdown = newPath.endsWith('.md') && !newPath.toLowerCase().endsWith('.excalidraw.md');
    const title = isMarkdown ? newPath.slice(0, -3) : newPath;

    try {
      const res = await fetch(`${this.settings.serverUrl}/api/workspaces/${this.settings.workspaceId}/documents/${docId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.settings.token}`
        },
        body: JSON.stringify({ title })
      });
      if (res.ok) {
        this.logEvent('success', `Updated server document title for docId "${docId}" to "${title}"`);
      } else {
        this.logEvent('error', `Failed to update server title for docId "${docId}": HTTP ${res.status}`);
      }
    } catch (err: any) {
      this.logEvent('error', `Failed to update server title for docId "${docId}": ${err.message || err}`);
    }
  }

  private async cleanEmptyFolders(deletedFiles: Set<string>) {
    const foldersToCheck = new Set<string>();
    for (const filePath of deletedFiles) {
      const parts = filePath.split('/');
      if (parts.length > 1) {
        let current = '';
        for (let i = 0; i < parts.length - 1; i++) {
          current = current ? `${current}/${parts[i]}` : parts[i];
          if (!current.startsWith('.')) {
            foldersToCheck.add(current);
          }
        }
      }
    }

    if (foldersToCheck.size === 0) return;

    // Convert to array and sort by depth descending (deepest paths first)
    const sortedFolders = Array.from(foldersToCheck).sort((a, b) => {
      return b.split('/').length - a.split('/').length;
    });

    for (const folderPath of sortedFolders) {
      const abstractFile = this.app.vault.getAbstractFileByPath(folderPath);
      if (abstractFile instanceof TFolder) {
        if (abstractFile.children.length === 0) {
          try {
            this.isApplyingRemoteUpdate = true; // prevent triggering file creation events
            this.addProgrammedModification(folderPath);
            await this.app.vault.delete(abstractFile);
            this.logEvent('info', `Deleted empty folder "${folderPath}"`);
          } catch (err: any) {
            this.deleteProgrammedModification(folderPath);
            console.warn(`CoSync: Failed to delete empty folder "${folderPath}":`, err);
          } finally {
            this.isApplyingRemoteUpdate = false;
          }
        }
      }
    }
  }

  private async disconnectActive() {
    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
      this.syncTimeout = null;
    }
    if (this.wsProvider) {
      console.log('Disconnecting from active WebSocket room...');
      try {
        this.wsProvider.disconnect();
        this.wsProvider.destroy();
      } catch (err) {
        console.error('Error destroying WebsocketProvider:', err);
      }
      this.wsProvider = null;
      this.updateStatusBar('disconnected');
    }

    if (this.ydoc && this.activeFile) {
      // Force write the final Yjs state to disk on disconnect to ensure nothing is lost
      const yContent = this.ydoc.getText('codemirror').toString();
      try {
        const currentContent = await this.app.vault.read(this.activeFile);
        const normalizeText = (str: string) => str.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
        const isMarkdown = this.activeFile.extension.toLowerCase() === 'md';
        const yContentWithId = isMarkdown ? stripCosyncId(yContent) : yContent;
        if (normalizeText(yContentWithId) !== normalizeText(currentContent)) {
          this.isApplyingRemoteUpdate = true;
          this.addProgrammedModification(this.activeFile.path);
          try {
            await this.app.vault.modify(this.activeFile, yContentWithId);
          } catch (err) {
            this.deleteProgrammedModification(this.activeFile.path);
            throw err;
          } finally {
            this.isApplyingRemoteUpdate = false;
          }
          
          if (this.activeDocumentId) {
            await this.markDocumentSynced(this.activeDocumentId, yContentWithId, getContentHash(yContentWithId));
          }
        }
      } catch (err) {
        console.error('Failed to save final state on disconnect:', err);
      }
    }

    if (this.ydoc) {
      this.ydoc.destroy();
      this.ydoc = null;
    }

    this.activeFile = null;
    this.activeDocumentId = null;

    // Clear CodeMirror extension so it doesn't stay bound to the destroyed doc
    if (this.boundEditorView) {
      try {
        this.boundEditorView.dispatch({
          effects: this.yjsCompartment.reconfigure([])
        });
      } catch (err) {
        console.error('Error clearing CodeMirror compartment:', err);
      }
      this.boundEditorView = null;
    }
  }

  private bindYjsToEditor() {
    if (!this.ydoc || !this.wsProvider || !this.activeFile) return;

    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView && activeView.file?.path.normalize('NFC') === this.activeFile.path.normalize('NFC')) {
      const editor = activeView.editor as any;
      if (editor && editor.cm) {
        const cmView = editor.cm as EditorView;
        
        if (this.boundEditorView === cmView) {
          return; // Already bound to this EditorView
        }

        const ytext = this.ydoc.getText('codemirror');
        
        // SAFEGUARD: Make sure the WebSocket provider is fully synced before binding to prevent duplication
        if (!this.wsProvider.synced) {
          console.log('CoSync: Deferring editor binding until WebSocket provider is synced.');
          return;
        }

        // If previously bound to a different view, clear it first
        if (this.boundEditorView) {
          try {
            this.boundEditorView.dispatch({
              effects: this.yjsCompartment.reconfigure([])
            });
          } catch (err) {
            console.error('CoSync: Error clearing old editor view:', err);
          }
        }

        console.log('CoSync: Binding yCollab to active editor.');
        const cursorListener = this.buildCursorListener(ytext);
        const extension: Extension = [
          yCollab(ytext, this.wsProvider.awareness),
          cursorListener
        ];
        
        try {
          cmView.dispatch({
            effects: this.yjsCompartment.reconfigure(extension)
          });
          this.boundEditorView = cmView;
        } catch (err) {
          console.error('CoSync: Error configuring CodeMirror compartment:', err);
        }
      }
    }
  }

  private buildCursorListener(ytext: Y.Text): Extension {
    return EditorView.updateListener.of((update) => {
      if (!this.wsProvider || !this.activeDocumentId) return;

      if (update.selectionSet || update.docChanged) {
        try {
          const head = update.state.selection.main.head;
          const relativePos = Y.createRelativePositionFromTypeIndex(ytext, head);
          this.wsProvider.awareness.setLocalStateField('cursor', {
            anchor: relativePos,
            head: relativePos
          });
        } catch (err) {
          console.warn('CoSync: Error updating cursor awareness:', err);
        }
      }
    });
  }

  private async getUniqueConflictPath(file: TFile): Promise<string> {
    const dir = file.parent ? file.parent.path : '';
    const baseName = file.basename;
    const ext = file.extension ? '.' + file.extension : '';
    const device = this.settings.displayName || 'Device';
    
    let attempt = 0;
    while (true) {
      const suffix = attempt === 0 ? '' : ` (${attempt})`;
      const conflictFileName = `${baseName} (Conflict - ${device})${suffix}${ext}`;
      const conflictPath = dir && dir !== '/' ? `${dir}/${conflictFileName}` : conflictFileName;
      
      const exists = this.app.vault.getAbstractFileByPath(conflictPath);
      if (!exists) {
        return conflictPath;
      }
      attempt++;
    }
  }

  private async getCacheDir(): Promise<string> {
    const cachePath = `${this.manifest.dir}/cache`;
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(cachePath))) {
      await adapter.mkdir(cachePath);
    }
    return cachePath;
  }

  private async saveBaseText(docId: string, content: string) {
    try {
      const cacheDir = await this.getCacheDir();
      const filePath = `${cacheDir}/${docId}.txt`;
      await this.app.vault.adapter.write(filePath, content);
    } catch (err) {
      console.warn('CoSync: Failed to save base text cache:', err);
    }
  }

  private async readBaseText(docId: string): Promise<string | null> {
    try {
      const cacheDir = await this.getCacheDir();
      const filePath = `${cacheDir}/${docId}.txt`;
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(filePath)) {
        return await adapter.read(filePath);
      }
    } catch (err) {
      console.warn('CoSync: Failed to read base text cache:', err);
    }
    return null;
  }

  private async markDocumentSynced(docId: string, content: string, hash: string) {
    this.settings.syncHashes[docId] = hash;
    await this.saveSettings();
    await this.saveBaseText(docId, content);
  }

  /**
   * Splits a file's content into frontmatter and body.
   */
  private splitFrontmatterAndBody(content: string): { frontmatter: string; body: string } {
    const cleanContent = content.replace(/^\uFEFF/, '');
    const frontmatterRegex = /^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n/;
    const match = cleanContent.match(frontmatterRegex);
    if (match) {
      const frontmatter = match[0];
      const body = cleanContent.substring(frontmatter.length);
      return { frontmatter, body };
    }
    return { frontmatter: '', body: cleanContent };
  }

  private async fetchServerDocuments(forceRefresh = false): Promise<any[]> {
    const now = Date.now();
    // Cache for 10 seconds to cover rapid file switches / batch operations
    if (!forceRefresh && this.serverDocsCache && (now - this.serverDocsCacheTime) < 10000) {
      return this.serverDocsCache;
    }
    const response = await fetch(`${this.settings.serverUrl}/api/workspaces/${this.settings.workspaceId}/documents`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.settings.token}`
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP Error ${response.status}: Failed to fetch documents`);
    }

    this.serverDocsCache = await response.json();
    this.serverDocsCacheTime = now;
    return this.serverDocsCache!;
  }

  /**
   * Resolves the CoSync document ID for a given file.
   * 1. Checks frontmatter for 'cosyncId'.
   * 2. If not found, fetches workspace documents from server and looks for a matching title.
   * 3. If found, writes it to frontmatter.
   * 4. If not found, creates a new document on server and writes it to frontmatter.
   */
  private async resolveDocumentId(file: TFile): Promise<string> {
    const normalizedPath = file.path.normalize('NFC');
    try {
      if (!this.settings.fileMappings) {
        this.settings.fileMappings = {};
      }

      // Load server documents from cached helper
      const documents = await this.fetchServerDocuments();
      const serverDocIdSet = new Set(documents.map((d: any) => d.id));
      const title = normalizedPath.endsWith('.md') ? normalizedPath.slice(0, -3) : normalizedPath;
      const matchByTitle = documents.find((d: any) => d.title.trim().toLowerCase() === title.trim().toLowerCase());

      // 1. Check settings mapping
      let docId = this.settings.fileMappings[normalizedPath];
      if (docId && serverDocIdSet.has(docId)) {
        // Exists on server, rename if title changed
        const currentTitle = normalizedPath.endsWith('.md') ? normalizedPath.slice(0, -3) : normalizedPath;
        fetch(`${this.settings.serverUrl}/api/workspaces/${this.settings.workspaceId}/documents/${docId}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.settings.token}`
          },
          body: JSON.stringify({ title: currentTitle })
        }).catch(err => console.warn('CoSync: Error updating renamed/moved file title on server:', err));
        
        return docId;
      }

      // 2. Check file cache frontmatter (for backward compatibility)
      const cache = this.app.metadataCache.getFileCache(file);
      const existingId = cache?.frontmatter?.['cosyncId'];

      if (existingId && serverDocIdSet.has(existingId)) {
        console.log(`CoSync: Found existing document ID in metadata cache: ${existingId}`);
        this.settings.fileMappings[normalizedPath] = existingId;
        await this.saveSettings();
        return existingId;
      }

      // 3. Match by title
      if (matchByTitle) {
        docId = matchByTitle.id;
        console.log(`CoSync: Found matching document on server by title: ${title} (${docId})`);
        this.settings.fileMappings[normalizedPath] = docId;
        
        const isMarkdown = file.extension.toLowerCase() === 'md';
        if (isMarkdown) {
          // Inject / Update frontmatter to have correct server ID
          const fileContent = await this.app.vault.read(file);
          const contentWithId = stripCosyncId(fileContent);
          
          this.isApplyingRemoteUpdate = true;
          this.addProgrammedModification(normalizedPath);
          try {
            await this.app.vault.modify(file, contentWithId);
          } catch (err) {
            this.deleteProgrammedModification(normalizedPath);
          } finally {
            this.isApplyingRemoteUpdate = false;
          }
        }

        this.settings.fileMappings[normalizedPath] = docId;
        await this.saveSettings();
        return docId;
      }

      // 4. Create document on server
      console.log(`CoSync: No matching document found on server. Creating: "${title}"`);
      const createResponse = await fetch(`${this.settings.serverUrl}/api/workspaces/${this.settings.workspaceId}/documents`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.settings.token}`
        },
        body: JSON.stringify({ title })
      });

      if (!createResponse.ok) {
        throw new Error(`HTTP Error ${createResponse.status}: Failed to create document`);
      }

      const newDoc = await createResponse.json();
      docId = newDoc.id;
      this.serverDocsCache = null; // Invalidate cache since a new document is created
      console.log(`CoSync: Created new document on server: ${title} (${docId})`);
      
      const fileContent = await this.app.vault.read(file);
      const isMarkdown = file.extension.toLowerCase() === 'md';
      if (isMarkdown) {
        const contentWithId = stripCosyncId(fileContent);
        
        this.isApplyingRemoteUpdate = true;
        this.addProgrammedModification(normalizedPath);
        try {
          await this.app.vault.modify(file, contentWithId);
        } catch (err) {
          this.deleteProgrammedModification(normalizedPath);
        } finally {
          this.isApplyingRemoteUpdate = false;
        }
      }

      this.settings.fileMappings[normalizedPath] = docId;
      await this.saveSettings();
      return docId;
    } catch (err: any) {
      if (err.message && (err.message.includes('HTTP Error 401') || err.message.includes('HTTP Error 403') || err.message.includes('HTTP Error 404'))) {
        console.error('CoSync: Permanent error resolving document ID from server:', err);
        throw err;
      }
      console.warn('CoSync: Error resolving document ID from server. Falling back to local ID:', err);
      return this.getDocumentIdForFile(file);
    }
  }

  /**
   * Helper: Generates a sanitized document ID from note file metadata.
   */
  private getDocumentIdForFile(file: TFile): string {
    // Standardize file paths to avoid character conflicts in room URL strings
    const rawPath = `${this.settings.workspaceId}/${file.path}`;
    // A simple hash function to make a unique, URL-safe alphanumeric ID
    let hash = 0;
    for (let i = 0; i < rawPath.length; i++) {
      hash = (hash << 5) - hash + rawPath.charCodeAt(i);
      hash |= 0;
    }
    return 'obs-' + Math.abs(hash).toString(36) + '-' + file.basename.replace(/[^a-zA-Z0-9]/g, '');
  }

  public async reconnect() {
    await this.disconnectActive();
    this.activeFile = null;
    await this.handleFileSwitch(true);
  }

  /**
   * Binds the current active note to the server.
   */
  private async handleFileSwitch(force = false) {
    const file = this.app.workspace.getActiveFile();
    if (!file || !SYNCABLE_EXTENSIONS.has(file.extension.toLowerCase()) || file.path.toLowerCase().endsWith('.excalidraw.md')) {
      this.disconnectActive();
      return;
    }

    if (!force && this.activeFile && this.activeFile.path === file.path) {
      return; // No change
    }

    // Disconnect existing session
    await this.disconnectActive();
    this.activeFile = file;

    if (!this.settings.token) {
      console.warn('CoSync: JWT authentication token is missing. Please configure in settings.');
      return;
    }

    // Capture initial file content BEFORE connecting to prevent it from being overwritten before reconciliation
    const initialFileContent = await this.app.vault.read(file);

    // Resolve the real documentId from the server
    let documentId: string;
    try {
      documentId = await this.resolveDocumentId(file);
    } catch (err: any) {
      console.error('CoSync: Failed to resolve document ID:', err);
      this.updateStatusBar('disconnected', 'CoSync: Connection Error');
      this.logEvent('error', `Connection failed: ${err.message || err}`);
      return;
    }

    if (this.activeFile !== file) {
      // The user switched files while we were waiting for the server
      return;
    }
    this.activeDocumentId = documentId;

    const wsUrl = this.settings.serverUrl.replace(/^http/, 'ws');
    const roomName = `workspace/${this.settings.workspaceId}/doc/${documentId}`;

    console.log(`Connecting to collaborative room: ${roomName}`);

    // Initialize Y.Doc & WS Connection
    this.ydoc = new Y.Doc();
    const ytext = this.ydoc.getText('codemirror');

    this.wsProvider = new WebsocketProvider(wsUrl, roomName, this.ydoc, {
      connect: true,
      protocols: ['co-sync-auth', this.settings.token]
    });

    this.updateStatusBar('connecting');
    this.wsProvider.on('status', ({ status }) => {
      this.updateStatusBar(status as any);
      this.updateSidebarViews();
    });

    this.wsProvider.on('sync', (isSynced) => {
      if (isSynced) {
        console.log('CoSync: Collaborative room synced. Binding to editor.');
        this.bindYjsToEditor();
        this.updateSidebarViews();
      }
    });

    // Configure reconnect backoff
    this.wsProvider.maxBackoffTime = 30000;

    // Set local awareness identifier
    const userName = this.settings.displayName || 'Obsidian User';
    this.wsProvider.awareness.setLocalStateField('user', {
      name: userName,
      color: getDeterministicColor(userName),
      userId: 'obsidian-client'
    });

    this.wsProvider.awareness.on('change', () => {
      this.updateSidebarViews();
    });


    // Sync remote updates from browser directly to the local note file on disk
    ytext.observe((event, transaction) => {
      // Ignore local transactions initiated by this Obsidian instance
      if (transaction && transaction.local) return;

      if (this.syncTimeout) clearTimeout(this.syncTimeout);

      // Dynamic debounce: write faster (100ms) if the user is not actively editing in Obsidian (unfocused),
      // and use a safe longer delay (1500ms) if focused to prevent interrupting active input.
      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      const isFocused = activeView && activeView.file?.path.normalize('NFC') === this.activeFile?.path.normalize('NFC') && activeView.editor?.hasFocus();
      const debounceDelay = isFocused ? 1500 : 100;

      this.syncTimeout = setTimeout(async () => {
        this.syncTimeout = null;
        await this.syncYDocToLocalFile();
      }, debounceDelay);
    });

    // We do not observe and modify the disk file during active typing/sync
    // because yCollab updates CodeMirror directly, and Obsidian auto-saves
    // the active CodeMirror document to disk. Manual modify triggers editor reloads.

    // Reconcile offline modifications once synced with server
    this.wsProvider.on('sync', async (isSynced: boolean) => {
      if (isSynced && this.activeFile === file && this.ydoc) {
        const isMarkdown = file.extension.toLowerCase() === 'md';

        const serverContent = ytext.toString();
        const serverContentWithId = isMarkdown ? stripCosyncId(serverContent) : serverContent;
        const serverHash = getContentHash(serverContentWithId);
        const localContent = await this.app.vault.read(file);
        const localHash = getContentHash(localContent);
        const lastSyncedHash = this.settings.syncHashes[documentId];

        if (localContent === serverContentWithId) {
          await this.markDocumentSynced(documentId, localContent, localHash);
          return;
        }

        // If Yjs is already active/bound, let live sync handle everything.
        if (this.boundEditorView) {
          await this.markDocumentSynced(documentId, serverContentWithId, serverHash);
          return;
        }

        if (!lastSyncedHash) {
          // Case A: First time sync
          if (serverContent === '') {
            // Server is empty, initialize it with local content
            this.ydoc.transact(() => {
              ytext.insert(0, localContent);
            }, 'local-init');
            await this.markDocumentSynced(documentId, localContent, localHash);
            console.log(`CoSync: Initialized empty server document with local content.`);
          } else {
            // Server has content. Overwrite local with server.
            if (localContent !== serverContentWithId) {
              this.isApplyingRemoteUpdate = true;
              this.addProgrammedModification(file.path);
              try {
                await this.app.vault.modify(file, serverContentWithId);
              } catch (err) {
                this.deleteProgrammedModification(file.path);
                throw err;
              } finally {
                this.isApplyingRemoteUpdate = false;
              }
            }
            await this.markDocumentSynced(documentId, serverContentWithId, serverHash);
            console.log(`CoSync: First-time sync completed from server content.`);
          }
        } else {
          // Case B: Subsequent sync
          const localChanged = localHash !== lastSyncedHash;
          const serverChanged = serverHash !== lastSyncedHash;

          if (localChanged && !serverChanged) {
            // Push local changes to server cleanly
            this.ydoc.transact(() => {
              updateYTextCleanly(ytext, localContent);
            }, 'local-reconciliation-push');
            await this.markDocumentSynced(documentId, localContent, localHash);
            console.log(`CoSync: Pushed offline local changes to server.`);
          } else if (!localChanged && serverChanged) {
            // Pull server changes to local note
            this.isApplyingRemoteUpdate = true;
            this.addProgrammedModification(file.path);
            try {
              await this.app.vault.modify(file, serverContentWithId);
            } catch (err) {
              this.deleteProgrammedModification(file.path);
              throw err;
            } finally {
              this.isApplyingRemoteUpdate = false;
            }
            await this.markDocumentSynced(documentId, serverContentWithId, serverHash);
            console.log(`CoSync: Pulled offline remote changes from server.`);
          } else if (localChanged && serverChanged) {
            // Both changed: 3-way merge!
            console.log(`CoSync: Conflict detected on "${file.path}"! Attempting automated 3-way merge...`);
            const baseText = await this.readBaseText(documentId);
            
            if (baseText !== null && baseText !== '') {
              // Perform CRDT 3-way merge using Yjs and applyDiff
              this.ydoc.transact(() => {
                applyDiff(ytext, baseText, localContent);
              }, 'local-reconciliation-merge');

              const mergedContent = ytext.toString();
              const mergedContentWithId = isMarkdown ? stripCosyncId(mergedContent) : mergedContent;
              const mergedHash = getContentHash(mergedContentWithId);

              this.isApplyingRemoteUpdate = true;
              this.addProgrammedModification(file.path);
              try {
                await this.app.vault.modify(file, mergedContentWithId);
              } catch (err) {
                this.deleteProgrammedModification(file.path);
                throw err;
              } finally {
                this.isApplyingRemoteUpdate = false;
              }
              await this.markDocumentSynced(documentId, mergedContentWithId, mergedHash);
              console.log(`CoSync: Automatically merged offline changes successfully.`);
            } else {
              // No base text found (fallback): append local edits at the bottom of the server file
              console.log(`CoSync: No base text cache found. Appending local version at the bottom.`);
              const separator = `\n\n%% CoSync Conflict Merge Suffix %%\n${localContent}\n`;
              const mergedContentWithId = serverContentWithId + separator;
              const mergedHash = getContentHash(mergedContentWithId);

              // Update Yjs text to match merged
              this.ydoc.transact(() => {
                updateYTextCleanly(ytext, mergedContentWithId);
              }, 'local-reconciliation-merge-fallback');

              this.isApplyingRemoteUpdate = true;
              this.addProgrammedModification(file.path);
              try {
                await this.app.vault.modify(file, mergedContentWithId);
              } catch (err) {
                this.deleteProgrammedModification(file.path);
                throw err;
              } finally {
                this.isApplyingRemoteUpdate = false;
              }
              await this.markDocumentSynced(documentId, mergedContentWithId, mergedHash);
              new Notice(`CoSync: Merged local and remote edits into a single note.`);
            }
          }
        }

        // Try to bind yCollab now that ytext and local content match
        this.bindYjsToEditor();
      }
    });

    // Also attempt to bind yCollab immediately if possible, with safety retries in case the CodeMirror view is still mounting
    this.bindYjsToEditor();
    setTimeout(() => this.bindYjsToEditor(), 100);
    setTimeout(() => this.bindYjsToEditor(), 500);
    setTimeout(() => this.bindYjsToEditor(), 1500);
  }

  /**
   * Writes remote Yjs state changes back to the active vault file.
   */
  private async syncYDocToLocalFile() {
    if (!this.activeFile || !this.ydoc) return;

    const isMarkdown = this.activeFile.extension.toLowerCase() === 'md';

    // SAFEGUARD: If editor is open in Editing Mode (Source/Live Preview), CodeMirror's yCollab handles sync in-memory.
    // Writing to disk now conflicts with user input and triggers Obsidian's native external modification watcher
    // ("File modified externally, merging automatically..."), which resets selection and ruins the text.
    // We only write to disk if the note is closed/background, or open in Reading Mode (preview).
    if (isMarkdown) {
      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (activeView && activeView.file?.path === this.activeFile.path && activeView.getMode() === 'source') {
        console.log('CoSync: Skipping disk write because active editor is open in Editing Mode.');
        return;
      }
    }
    
    const yContent = this.ydoc.getText('codemirror').toString();
    const yContentWithId = isMarkdown ? stripCosyncId(yContent) : yContent;

    try {
      const currentContent = await this.app.vault.read(this.activeFile);
      const normalizeText = (str: string) => str.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();

      if (normalizeText(yContentWithId) !== normalizeText(currentContent)) {
        // SAFEGUARD: Set flag so that vault.on('modify') does not treat this write
        // as a local edit transaction and recursively push it back to the server.
        this.isApplyingRemoteUpdate = true;
        this.addProgrammedModification(this.activeFile.path);
        try {
          await this.app.vault.modify(this.activeFile, yContentWithId);
        } catch (err) {
          this.deleteProgrammedModification(this.activeFile.path);
          throw err;
        } finally {
          this.isApplyingRemoteUpdate = false;
        }
        
        if (this.activeDocumentId) {
          await this.markDocumentSynced(this.activeDocumentId, yContentWithId, getContentHash(yContentWithId));
        }
      }
    } catch (error) {
      this.isApplyingRemoteUpdate = false;
      console.error('Failed to sync YDoc content to local vault note', error);
    }
  }

  /**
   * Handles external note file modifications (e.g. Git pull, third-party editor).
   * CONFLICT RESOLUTION: We calculate text modifications and apply them as a local
   * transaction to Y.Doc, which handles CRDT reconciliation automatically.
   */
  private async handleExternalModification(file: TFile) {
    if (this.hasProgrammedModification(file.path)) {
      this.deleteProgrammedModification(file.path);
      return;
    }

    // Excalidraw files (.excalidraw.md) end in .md but are NOT regular markdown:
    // they must never be processed by the Yjs text-diff engine.
    const isMarkdown = file.extension.toLowerCase() === 'md' && !this.isExcalidrawFile(file.path);

    // If WebSocket is connected, yCollab handles all sync (only for Markdown).
    // External modification check is only needed for offline reconciliation or when disconnected,
    // or for non-markdown files where yCollab is not active.
    if (isMarkdown && this.wsProvider && this.wsProvider.wsconnected) {
      return;
    }

    // Only check if it matches our active note and is NOT a write from the remote sync listener
    if (!this.activeFile || this.activeFile.path !== file.path || this.isApplyingRemoteUpdate || !this.ydoc) {
      return;
    }

    // Safeguard: If the editor currently has focus, it means the user is editing
    // and yCollab is active. Any file writes are just autosaves, so skip syncing.
    if (isMarkdown) {
      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (activeView && activeView.file?.path === file.path && activeView.editor?.hasFocus()) {
        return;
      }
    }

    try {
      const newContent = await this.app.vault.read(file);
      const ytext = this.ydoc.getText('codemirror');
      const currentYText = ytext.toString();
      const normalizeText = (str: string) =>
        str
          .replace(/^\uFEFF/, '')
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n')
          .replace(/\s+/g, ' ')
          .trim();

      const newHash = getContentHash(newContent);
      if (normalizeText(newContent) !== normalizeText(currentYText)) {
        console.log('External note modification detected (Git/VSCode/Offline). Reconciling via Yjs...');
        
        this.ydoc.transact(() => {
          updateYTextCleanly(ytext, newContent);
        }, 'external-modification');
        
        if (this.activeDocumentId) {
          await this.markDocumentSynced(this.activeDocumentId, newContent, newHash);
        }
      } else {
        // Text is identical, but file was saved to disk, so update the last synced hash to match
        if (this.activeDocumentId && this.settings.syncHashes[this.activeDocumentId] !== newHash) {
          await this.markDocumentSynced(this.activeDocumentId, newContent, newHash);
        }
      }
    } catch (err) {
      console.error('Failed to reconcile external vault file modification', err);
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.syncHashes) {
      this.settings.syncHashes = {};
    } else {
      const normalizedSyncHashes: Record<string, string> = {};
      for (const [key, val] of Object.entries(this.settings.syncHashes)) {
        normalizedSyncHashes[key.normalize('NFC')] = val;
      }
      this.settings.syncHashes = normalizedSyncHashes;
    }
    if (!this.settings.fileMappings) {
      this.settings.fileMappings = {};
    } else {
      const normalizedFileMappings: Record<string, string> = {};
      for (const [key, val] of Object.entries(this.settings.fileMappings)) {
        const normKey = key.normalize('NFC');
        if (normKey.toLowerCase().endsWith('.excalidraw.md') || normKey.toLowerCase().endsWith('.excalidraw')) {
          continue; // Clean up old document mapping for Excalidraw files
        }
        normalizedFileMappings[normKey] = val;
      }
      this.settings.fileMappings = normalizedFileMappings;
    }
    if (!this.settings.deletedFilesQueue) {
      this.settings.deletedFilesQueue = [];
    }
  }

  async saveSettings() {
    // If workspaceId is "create-new", create a workspace on the server named after the vault
    if (this.settings.workspaceId === 'create-new') {
      try {
        const vaultName = this.app.vault.getName();
        console.log(`CoSync: Creating workspace on server for vault "${vaultName}"...`);
        const res = await fetch(`${this.settings.serverUrl}/api/workspaces`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.settings.token}`
          },
          body: JSON.stringify({ name: vaultName })
        });
        if (res.ok) {
          const data = await res.json();
          this.settings.workspaceId = data.id;
          console.log(`CoSync: Created workspace on server: ${data.name} (${data.id})`);
          new Notice(`CoSync: Created new workspace: "${data.name}"`);
        } else {
          console.error('CoSync: Failed to create workspace on server', res.statusText);
          new Notice('CoSync: Failed to create workspace on server.');
        }
      } catch (err) {
        console.error('CoSync: Error creating workspace on server', err);
        new Notice('CoSync: Error connecting to server.');
      }
    }

    await this.saveData(this.settings);
    this.connectGlobalWebSocket();
  }

  /**
   * Saves settings AND reconnects the active file. Only call this when
   * the user explicitly changes connection-related settings.
   */
  async saveSettingsAndReconnect() {
    await this.saveData(this.settings);
    this.handleFileSwitch();
  }

  async syncEntireVault() {
    await this.syncVault(true);
  }

  async syncVault(isManual = false) {
    if (this.isSyncing) return;
    if (!this.settings.token || !this.settings.workspaceId) return;

    this.isSyncing = true;
    this.logEvent('info', 'Starting vault synchronization...');
    this.currentSyncRunEvents = [];
    this.updateStatusBar('syncing');

    let uploadedCount = 0;
    let downloadedCount = 0;
    let deletedCount = 0;
    let reconciledCount = 0;
    const errors: string[] = [];
    const filesDeletedDuringSync = new Set<string>();

    try {
      // 1. Fetch server documents
      let serverDocs = await this.fetchServerDocuments(true);

      // 2. Fetch server attachments
      const attachResponse = await fetch(`${this.settings.serverUrl}/api/workspaces/${this.settings.workspaceId}/attachments`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.settings.token}`
        }
      });
      if (!attachResponse.ok) {
        throw new Error(`Failed to fetch attachments: ${attachResponse.statusText}`);
      }
      let serverAttachments: Array<{ id: string; filepath: string; hash: string; size: number }> = await attachResponse.json();
      const serverAttachMap = new Map(serverAttachments.map(a => [a.filepath.toLowerCase(), a]));

      // 3. Scan local files
      const localFiles = this.app.vault.getFiles();
      const localSyncable = localFiles.filter(f => {
        const pathNormalized = f.path.normalize('NFC');
        if (pathNormalized === 'cosync-sync-log.md') return false;
        const pathLower = f.path.toLowerCase();
        if (pathLower.endsWith('.excalidraw.md')) return false;
        return SYNCABLE_EXTENSIONS.has(f.extension.toLowerCase());
      });
      const localBinary = localFiles.filter(f => {
        const pathLower = f.path.toLowerCase();
        if (pathLower.endsWith('.excalidraw.md')) return true;
        return !SYNCABLE_EXTENSIONS.has(f.extension.toLowerCase());
      });

      // If configuration sync is enabled, append target hidden files!
      if (this.settings.syncConfig) {
        const targetConfigs = [
          '.obsidian/appearance.json',
          '.obsidian/hotkeys.json',
          '.obsidian/core-plugins.json',
          '.obsidian/community-plugins.json'
        ];
        
        try {
          if (await this.app.vault.adapter.exists('.obsidian/snippets')) {
            const list = await this.app.vault.adapter.list('.obsidian/snippets');
            if (list && list.files) {
              for (const file of list.files) {
                if (file.endsWith('.css')) {
                  targetConfigs.push(file);
                }
              }
            }
          }
        } catch (e) {
          console.warn('CoSync: Error listing CSS snippets:', e);
        }

        for (const configPath of targetConfigs) {
          if (await this.app.vault.adapter.exists(configPath)) {
            // We push a mock TFile-like object into localBinary so the rest of the binary sync loop treats it perfectly!
            localBinary.push({
              path: configPath,
              name: configPath.split('/').pop() || '',
              extension: configPath.split('.').pop() || '',
              vault: this.app.vault
            } as any);
          }
        }
      }

      const localSyncableMap = new Map(localSyncable.map(f => [f.path.normalize('NFC').toLowerCase(), f]));
      const localBinaryMap = new Map(localBinary.map(f => [f.path.normalize('NFC').toLowerCase(), f]));

      // Keep track of mapped document IDs on server
      const serverDocIdMap = new Map<string, typeof serverDocs[0]>();
      const serverDocTitleMap = new Map<string, typeof serverDocs[0]>();
      serverDocs.forEach(d => {
        serverDocIdMap.set(d.id, d);
        serverDocTitleMap.set(d.title.trim().normalize('NFC').toLowerCase(), d);
      });

      // Purge invalid non-syncable mappings from settings to clean up historical/corrupted settings
      for (const filePath of Object.keys(this.settings.fileMappings)) {
        const filePathNormalized = filePath.normalize('NFC');
        const ext = filePathNormalized.split('.').pop()?.toLowerCase();
        if (!ext || !SYNCABLE_EXTENSIONS.has(ext)) {
          const docId = this.settings.fileMappings[filePath];
          delete this.settings.fileMappings[filePath];
          delete this.settings.syncHashes[docId];
          delete this.settings.syncVersions[docId];
        }
      }

      // --- PHASE 0: Two-Way Deletion Sync ---

      // 0A. Propagate Local Deletions to Server (using queue-based deletion to prevent rename race conditions)
      const deletedQueue = this.settings.deletedFilesQueue || [];
      const remainingDeletedQueue: string[] = [];

      for (const filePath of deletedQueue) {
        const filePathNormalized = filePath.normalize('NFC');
        const docId = this.settings.fileMappings[filePathNormalized];
        
        if (docId) {
          console.log(`CoSync: Document "${filePathNormalized}" was deleted locally. Deleting on server...`);
          try {
            const res = await fetch(`${this.settings.serverUrl}/api/workspaces/${this.settings.workspaceId}/documents/${docId}`, {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${this.settings.token}` }
            });
            if (res.ok) {
              deletedCount++;
              this.logEvent('success', `Deleted server document for note "${filePathNormalized}"`);
              serverDocs = serverDocs.filter(d => d.id !== docId);
            } else if (res.status === 404) {
              this.logEvent('info', `Server document for "${filePathNormalized}" already deleted (404)`);
            } else {
              this.logEvent('error', `Failed to delete server document for "${filePathNormalized}": HTTP ${res.status}`);
              errors.push(`Failed to delete server document for "${filePathNormalized}": HTTP ${res.status}`);
              remainingDeletedQueue.push(filePathNormalized);
            }
          } catch (err: any) {
            this.logEvent('error', `Failed to delete server document for "${filePathNormalized}": ${err.message || err}`);
            errors.push(`Failed to delete server document for "${filePathNormalized}": ${err.message || err}`);
            remainingDeletedQueue.push(filePathNormalized);
          }
          delete this.settings.fileMappings[filePathNormalized];
          delete this.settings.syncHashes[docId];
          delete this.settings.syncVersions[docId];
        } else {
          // If it's not a document, check if it was an attachment
          const lastHash = this.settings.syncHashes[filePathNormalized];
          if (lastHash) {
            console.log(`CoSync: Attachment "${filePathNormalized}" was deleted locally. Deleting on server...`);
            try {
              const res = await fetch(`${this.settings.serverUrl}/api/workspaces/${this.settings.workspaceId}/attachments?filepath=${encodeURIComponent(filePathNormalized)}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${this.settings.token}` }
              });
              if (res.ok) {
                deletedCount++;
                this.logEvent('success', `Deleted server attachment "${filePathNormalized}"`);
                serverAttachments = serverAttachments.filter(a => a.filepath.normalize('NFC').toLowerCase() !== filePathNormalized.toLowerCase());
              } else if (res.status === 404) {
                this.logEvent('info', `Server attachment for "${filePathNormalized}" already deleted (404)`);
              } else {
                this.logEvent('error', `Failed to delete server attachment for "${filePathNormalized}": HTTP ${res.status}`);
                errors.push(`Failed to delete server attachment for "${filePathNormalized}": HTTP ${res.status}`);
                remainingDeletedQueue.push(filePathNormalized);
              }
            } catch (err: any) {
              this.logEvent('error', `Failed to delete server attachment for "${filePathNormalized}": ${err.message || err}`);
              errors.push(`Failed to delete server attachment for "${filePathNormalized}": ${err.message || err}`);
              remainingDeletedQueue.push(filePathNormalized);
            }
            delete this.settings.syncHashes[filePathNormalized];
          }
        }
      }
      this.settings.deletedFilesQueue = remainingDeletedQueue;
      await this.saveSettings();

      // 0B. Propagate Server Deletions to Local
      const serverDocIds = new Set(serverDocs.map(d => d.id));
      const serverAttachPaths = new Set(serverAttachments.map(a => a.filepath.normalize('NFC').toLowerCase()));

      for (const [filePath, docId] of Object.entries(this.settings.fileMappings)) {
        const filePathNormalized = filePath.normalize('NFC');
        if (!serverDocIds.has(docId)) {
          if (this.activeDocumentId === docId) {
            console.log(`CoSync: Active document "${filePathNormalized}" was deleted on server. Disconnecting active room...`);
            await this.disconnectActive();
          }
          const localFile = localSyncableMap.get(filePathNormalized.toLowerCase());
          if (localFile && this.app.vault.getAbstractFileByPath(localFile.path)) {
            try {
              // Check if there are unsynced local changes
              const localContent = await this.app.vault.read(localFile);
              const localHash = getContentHash(localContent);
              const lastSyncedHash = this.settings.syncHashes[docId];
              const localChanged = localHash !== lastSyncedHash;

              if (localChanged) {
                this.logEvent('warn', `Document "${filePathNormalized}" was deleted on server but has local changes. Re-uploading...`);
                delete this.settings.fileMappings[filePath];
                delete this.settings.syncHashes[docId];
                delete this.settings.syncVersions[docId];
                continue;
              }

              console.log(`CoSync: Document "${filePathNormalized}" was deleted on server. Deleting locally...`);
              this.isApplyingRemoteUpdate = true;
              this.addProgrammedModification(filePathNormalized);
              try {
                await this.app.vault.delete(localFile);
                deletedCount++;
                filesDeletedDuringSync.add(filePathNormalized);
                this.logEvent('info', `Deleted local note "${filePathNormalized}" (synced server deletion)`);
              } catch (err: any) {
                this.deleteProgrammedModification(filePathNormalized);
                this.logEvent('error', `Failed to delete local document "${filePathNormalized}": ${err.message || err}`);
                errors.push(`Failed to delete local document "${filePathNormalized}": ${err.message || err}`);
              } finally {
                this.isApplyingRemoteUpdate = false;
              }
            } catch (err: any) {
              this.logEvent('error', `Error reading local document "${filePathNormalized}" during deletion sync: ${err.message || err}`);
              errors.push(`Error reading local document "${filePathNormalized}": ${err.message || err}`);
            }
          }
          delete this.settings.fileMappings[filePath];
          delete this.settings.syncHashes[docId];
          delete this.settings.syncVersions[docId];
        }
      }

      for (const [filePath, lastHash] of Object.entries(this.settings.syncHashes)) {
        const filePathNormalized = filePath.normalize('NFC');
        const isMarkdown = (filePathNormalized.endsWith('.md') && !filePathNormalized.toLowerCase().endsWith('.excalidraw.md')) || filePathNormalized.endsWith('.txt') || filePathNormalized.startsWith('doc_') || filePathNormalized.startsWith('obs-');
        if (!isMarkdown && !serverAttachPaths.has(filePathNormalized.toLowerCase())) {
          const localFile = localBinaryMap.get(filePathNormalized.toLowerCase());
          if (localFile && this.app.vault.getAbstractFileByPath(localFile.path)) {
            try {
              // Check if there are unsynced local changes
              const localBuffer = await this.readLocalBinary(filePathNormalized);
              const localHash = getBinaryHash(localBuffer);
              const localChanged = localHash !== lastHash;

              if (localChanged) {
                this.logEvent('warn', `Attachment "${filePathNormalized}" was deleted on server but has local changes. Re-uploading...`);
                delete this.settings.syncHashes[filePath];
                continue;
              }

              console.log(`CoSync: Attachment "${filePathNormalized}" was deleted on server. Deleting locally...`);
              this.isApplyingRemoteUpdate = true;
              this.addProgrammedModification(filePathNormalized);
              try {
                await this.deleteLocalFile(filePathNormalized, localFile);
                deletedCount++;
                filesDeletedDuringSync.add(filePathNormalized);
                this.logEvent('info', `Deleted local attachment "${filePathNormalized}" (synced server deletion)`);
              } catch (err: any) {
                this.deleteProgrammedModification(filePathNormalized);
                this.logEvent('error', `Failed to delete local attachment "${filePathNormalized}": ${err.message || err}`);
                errors.push(`Failed to delete local attachment "${filePathNormalized}": ${err.message || err}`);
              } finally {
                this.isApplyingRemoteUpdate = false;
              }
            } catch (err: any) {
              this.logEvent('error', `Error reading local attachment "${filePath}" during deletion sync: ${err.message || err}`);
              errors.push(`Error reading local attachment "${filePath}": ${err.message || err}`);
            }
          }
          delete this.settings.syncHashes[filePath];
        }
      }

      await this.saveData(this.settings);

      // --- STEP A: Sync Documents (Text, Canvas, JSON, Excalidraw) ---
      for (let file of localSyncable) {
        let normalizedFilePath = file.path.normalize('NFC');
        // Skip log file itself to avoid self-sync loop
        if (normalizedFilePath === 'cosync-sync-log.md') continue;

        if (filesDeletedDuringSync.has(normalizedFilePath)) {
          continue;
        }

        if (!this.app.vault.getAbstractFileByPath(file.path)) {
          continue;
        }

        // Skip empty Untitled notes
        const fileName = normalizedFilePath.split('/').pop()?.toLowerCase() || '';
        if (fileName.startsWith('untitled')) {
          try {
            const content = await this.app.vault.read(file);
            const cleanContent = stripCosyncId(content).trim();
            if (cleanContent === '') {
              continue;
            }
          } catch (e) {
            // Ignore read errors here, let normal flow handle it if needed
          }
        }

        const isMarkdown = file.extension.toLowerCase() === 'md';
        const title = isMarkdown ? (normalizedFilePath.endsWith('.md') ? normalizedFilePath.slice(0, -3) : normalizedFilePath) : normalizedFilePath;

        let docId = this.settings.fileMappings[normalizedFilePath];
        if (!docId && isMarkdown) {
          const cache = this.app.metadataCache.getFileCache(file);
          docId = cache?.frontmatter?.['cosyncId'];
        }

        // Verify if it exists on server
        let existsOnServer = docId && serverDocIdMap.has(docId);
        let matchedServerDoc = existsOnServer ? serverDocIdMap.get(docId!) : serverDocTitleMap.get(title.trim().toLowerCase());

        if (matchedServerDoc) {
          docId = matchedServerDoc.id;
          
          // --- DETECT RENAME/MOVE ON SERVER ---
          const expectedPath = (isMarkdown ? (matchedServerDoc.title.endsWith('.md') ? matchedServerDoc.title : `${matchedServerDoc.title}.md`) : matchedServerDoc.title).normalize('NFC');
          if (expectedPath.toLowerCase() !== normalizedFilePath.toLowerCase()) {
            console.log(`CoSync: Document path changed on server from "${normalizedFilePath}" to "${expectedPath}". Renaming locally...`);
            // Ensure parent directories exist
            const parts = expectedPath.split('/');
            if (parts.length > 1) {
              let current = '';
              for (let i = 0; i < parts.length - 1; i++) {
                current = current ? `${current}/${parts[i]}` : parts[i];
                if (!this.app.vault.getAbstractFileByPath(current)) {
                  await this.app.vault.createFolder(current);
                }
              }
            }
            
            this.isApplyingRemoteUpdate = true;
            this.addProgrammedModification(expectedPath);
            this.addProgrammedModification(normalizedFilePath);
            try {
              await this.app.vault.rename(file, expectedPath);
              this.logEvent('info', `Renamed local note "${normalizedFilePath}" to "${expectedPath}" (synced server rename)`);
              
              // Update local mappings dictionary
              delete this.settings.fileMappings[normalizedFilePath];
              this.settings.fileMappings[expectedPath] = docId;
              await this.saveData(this.settings);
              
              // Update the file reference to continue sync processing on the new path!
              const updatedFile = this.app.vault.getAbstractFileByPath(expectedPath);
              if (updatedFile instanceof TFile) {
                file = updatedFile;
                normalizedFilePath = expectedPath;
              }
            } catch (err: any) {
              this.deleteProgrammedModification(expectedPath);
              this.deleteProgrammedModification(normalizedFilePath);
              console.error('CoSync: Error renaming local document to match server title:', err);
              errors.push(`Error renaming local document "${normalizedFilePath}": ${err.message || err}`);
            } finally {
              this.isApplyingRemoteUpdate = false;
            }
          }

          this.settings.fileMappings[normalizedFilePath] = docId;

          // Check if sync is needed
          const localContent = await this.app.vault.read(file);
          const localHash = getContentHash(localContent);
          const lastSyncedHash = this.settings.syncHashes[docId];
          const serverVersion = matchedServerDoc.version;
          const lastSyncedVersion = this.settings.syncVersions[docId] || 0;

          const localChanged = localHash !== lastSyncedHash;
          const serverChanged = serverVersion > lastSyncedVersion;

          // If the file is currently open in an active Markdown editor, let yCollab handle real-time sync
          const activeMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
          const isCurrentActiveMarkdownFile = activeMarkdownView && activeMarkdownView.file?.path.normalize('NFC') === normalizedFilePath;

          if (isCurrentActiveMarkdownFile) {
            // Just update our tracked version and hash to match whatever yCollab has done
            this.settings.syncVersions[docId] = serverVersion;
            await this.markDocumentSynced(docId, localContent, localHash);
            continue;
          }

          if (localChanged || serverChanged) {
            console.log(`CoSync: Syncing background document "${normalizedFilePath}" (localChanged=${localChanged}, serverChanged=${serverChanged})`);
            try {
              const outcome = await this.reconcileBackgroundDoc(file, docId, isMarkdown, localContent, localHash, lastSyncedHash, serverVersion);
              if (outcome === 'uploaded') {
                uploadedCount++;
                this.logEvent('success', `Uploaded modifications for note "${normalizedFilePath}"`);
              } else if (outcome === 'downloaded') {
                downloadedCount++;
                this.logEvent('success', `Downloaded modifications for note "${normalizedFilePath}"`);
              } else if (outcome === 'merged') {
                uploadedCount++;
                downloadedCount++;
                reconciledCount++;
                this.logEvent('success', `Merged conflicts for note "${normalizedFilePath}"`);
              }
            } catch (err: any) {
              this.logEvent('error', `Failed to sync document "${normalizedFilePath}": ${err.message || err}`);
              errors.push(`Failed to sync document "${normalizedFilePath}": ${err.message || err}`);
            }
          }
        } else {
          // Document doesn't exist on server, create it
          console.log(`CoSync: Uploading new local document "${normalizedFilePath}" to server...`);
          const fileContent = await this.app.vault.read(file);
          try {
            const createResponse = await fetch(`${this.settings.serverUrl}/api/workspaces/${this.settings.workspaceId}/documents`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.settings.token}`
              },
              body: JSON.stringify({ title, initialContent: fileContent })
            });

            if (createResponse.ok) {
              const newDoc = await createResponse.json();
              const newDocId = newDoc.id;
              this.serverDocsCache = null; // Invalidate cache
              this.settings.fileMappings[normalizedFilePath] = newDocId;
              this.logEvent('success', `Uploaded new note "${normalizedFilePath}"`);

              const contentWithId = isMarkdown ? stripCosyncId(fileContent) : fileContent;
              if (isMarkdown && contentWithId !== fileContent) {
                this.isApplyingRemoteUpdate = true;
                this.addProgrammedModification(normalizedFilePath);
                try {
                  await this.app.vault.modify(file, contentWithId);
                } catch (e) {
                  this.deleteProgrammedModification(normalizedFilePath);
                } finally {
                  this.isApplyingRemoteUpdate = false;
                }
              }

              await this.markDocumentSynced(newDocId, contentWithId, getContentHash(contentWithId));
              this.settings.syncVersions[newDocId] = 0; // Will update on next fetch
              uploadedCount++;
            } else {
              this.logEvent('error', `Failed to upload local document "${normalizedFilePath}": HTTP ${createResponse.status}`);
              errors.push(`Failed to upload local document "${normalizedFilePath}": HTTP ${createResponse.status}`);
            }
          } catch (err: any) {
            this.logEvent('error', `Failed to upload local document "${normalizedFilePath}": ${err.message || err}`);
            errors.push(`Failed to upload local document "${normalizedFilePath}": ${err.message || err}`);
          }
        }
      }

      // Identify missing local files that exist on server
      for (const doc of serverDocs) {
        const docTitleNormalized = doc.title.normalize('NFC');
        const docTitleLower = docTitleNormalized.toLowerCase();
        if (docTitleLower === 'cosync-sync-log' || docTitleLower === 'cosync-sync-log.md') {
          continue;
        }
        if (docTitleLower.endsWith('.excalidraw.md') || docTitleLower.endsWith('.excalidraw')) {
          continue;
        }
        // If we don't have this doc mapped to any local file path
        const isMapped = Object.values(this.settings.fileMappings).includes(doc.id);
        if (!isMapped) {
          // Check if a file with the same title path already exists (case-insensitive)
          const docTitleNormalized = doc.title.normalize('NFC');
          const lowerTitle = docTitleNormalized.toLowerCase();
          
          // Get the extension of the document title
          const pathParts = lowerTitle.split('/');
          const fileName = pathParts[pathParts.length - 1];
          const fileParts = fileName.split('.');
          const ext = fileParts.length > 1 ? fileParts[fileParts.length - 1] : '';

          // If the title has an extension and it's not syncable, skip it!
          if (ext && !SYNCABLE_EXTENSIONS.has(ext)) {
            continue;
          }

          let expectedPath = docTitleNormalized;
          let isMarkdown = false;
          if (ext === 'txt') {
            isMarkdown = false;
          } else if (ext === 'md') {
            isMarkdown = true;
          } else {
            // No extension or unrecognized, default to .md
            expectedPath = expectedPath.endsWith('.md') ? expectedPath : `${expectedPath}.md`;
            isMarkdown = true;
          }

          const isAlreadyMapped = this.settings.fileMappings[expectedPath];
          if (isAlreadyMapped) {
            const uniquePath = this.getUniqueFilePath(expectedPath);
            console.log(`CoSync: Duplicate title mapping conflict for "${expectedPath}". Downloading as "${uniquePath}"...`);
            try {
              await this.downloadNewDocFromServer(doc.id, uniquePath, isMarkdown);
              downloadedCount++;
              this.logEvent('success', `Downloaded duplicate server document as "${uniquePath}"`);

              // Update the server document title to match the unique path
              const cleanTitle = isMarkdown ? (uniquePath.endsWith('.md') ? uniquePath.slice(0, -3) : uniquePath) : uniquePath;
              console.log(`CoSync: Updating server document title for duplicate to "${cleanTitle}"...`);
              await fetch(`${this.settings.serverUrl}/api/workspaces/${this.settings.workspaceId}/documents/${doc.id}`, {
                method: 'PUT',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${this.settings.token}`
                },
                body: JSON.stringify({ title: cleanTitle })
              });
            } catch (err: any) {
              this.logEvent('error', `Failed to download or rename duplicate server document: ${err.message || err}`);
              errors.push(`Failed to download or rename duplicate server document: ${err.message || err}`);
            }
          } else {
            const fileExists = localSyncableMap.has(expectedPath.toLowerCase());
            if (!fileExists) {
              console.log(`CoSync: Document "${docTitleNormalized}" is missing locally. Downloading...`);
              try {
                await this.downloadNewDocFromServer(doc.id, expectedPath, isMarkdown);
                downloadedCount++;
                this.logEvent('success', `Downloaded missing note "${expectedPath}"`);
              } catch (err: any) {
                this.logEvent('error', `Failed to download server document "${docTitleNormalized}": ${err.message || err}`);
                errors.push(`Failed to download server document "${docTitleNormalized}": ${err.message || err}`);
              }
            } else {
              // File exists but mapping was missing, map it
              const matchedFile = localSyncableMap.get(expectedPath.toLowerCase())!;
              this.settings.fileMappings[matchedFile.path.normalize('NFC')] = doc.id;
            }
          }
        }
      }

      // --- STEP B: Sync Attachments (Binary files like PNG, PDF, JPG) ---
      // Upload missing/modified attachments
      for (const file of localBinary) {
        const normalizedFilePath = file.path.normalize('NFC');
        if (filesDeletedDuringSync.has(normalizedFilePath)) {
          continue;
        }
        if (!this.app.vault.getAbstractFileByPath(file.path)) {
          continue;
        }
        try {
          const cooldownTime = this.downloadedFilesCooldown.get(normalizedFilePath.toLowerCase());
          if (cooldownTime && (Date.now() - cooldownTime < 4000)) {
            console.log(`CoSync: Skipping upload of recently downloaded file under cooldown: ${normalizedFilePath}`);
            continue;
          }
          const localBuffer = await this.readLocalBinary(normalizedFilePath);
          const localHash = getBinaryHash(localBuffer);
          const lastSyncedHash = this.settings.syncHashes[normalizedFilePath];

          const serverAttach = serverAttachMap.get(normalizedFilePath.toLowerCase());

          // Upload only when the server doesn't already have the current local content.
          // If serverAttach.hash === localHash the server is up-to-date; also update
          // lastSyncedHash so future runs don't redundantly re-check.
          if (serverAttach && serverAttach.hash === localHash) {
            if (lastSyncedHash !== localHash) {
              this.settings.syncHashes[normalizedFilePath] = localHash; // heal stale cache
            }
          } else if (!serverAttach || serverAttach.hash !== localHash) {
            console.log(`CoSync: Uploading background attachment "${normalizedFilePath}" (size=${localBuffer.byteLength} bytes)...`);
            const uploadRes = await fetch(
              `${this.settings.serverUrl}/api/workspaces/${this.settings.workspaceId}/attachments/upload?filepath=${encodeURIComponent(normalizedFilePath)}&hash=${localHash}`,
              {
                method: 'PUT',
                headers: {
                  'Authorization': `Bearer ${this.settings.token}`,
                  'Content-Type': 'application/octet-stream'
                },
                body: localBuffer
              }
            );
            if (uploadRes.ok) {
              this.settings.syncHashes[normalizedFilePath] = localHash;
              uploadedCount++;
              this.logEvent('success', `Uploaded attachment "${normalizedFilePath}"`);
            } else {
              this.logEvent('error', `Failed to upload attachment "${normalizedFilePath}": HTTP ${uploadRes.status}`);
              errors.push(`Failed to upload attachment "${normalizedFilePath}": HTTP ${uploadRes.status}`);
            }
          }
        } catch (err: any) {
          const normalizedFilePath = file.path.normalize('NFC');
          this.logEvent('error', `Failed to upload attachment "${normalizedFilePath}": ${err.message || err}`);
          errors.push(`Failed to upload attachment "${normalizedFilePath}": ${err.message || err}`);
        }
      }

      // Download missing/modified attachments from server
      for (const attach of serverAttachments) {
        try {
          const normalizedAttachPath = attach.filepath.normalize('NFC');
          const localFile = localBinaryMap.get(normalizedAttachPath.toLowerCase());
          const lastSyncedHash = this.settings.syncHashes[normalizedAttachPath];

          // Determine if we need to download:
          // - File is missing locally, OR
          // - Server hash differs from what we last synced AND differs from current local content
          //   (prevents a Device B from skipping a download when its lastSyncedHash is stale)
          let needsDownload = !localFile;
          if (!needsDownload && attach.hash !== lastSyncedHash) {
            // Server has something different from what we last synced.
            // Check actual local file content to confirm we don't already have the server version.
            try {
              const localBuffer = await this.readLocalBinary(normalizedAttachPath);
              const localHash = getBinaryHash(localBuffer);
              needsDownload = localHash !== attach.hash;
            } catch {
              needsDownload = true; // Can't read local file, re-download
            }
          }

          if (needsDownload) {
            console.log(`CoSync: Downloading background attachment "${normalizedAttachPath}" (size=${attach.size} bytes)...`);
            
            // Create parent folders if needed
            const pathParts = normalizedAttachPath.split('/');
            if (pathParts.length > 1) {
              let currentFolderPath = '';
              for (let i = 0; i < pathParts.length - 1; i++) {
                currentFolderPath = currentFolderPath ? `${currentFolderPath}/${pathParts[i]}` : pathParts[i];
                const folderExists = this.app.vault.getAbstractFileByPath(currentFolderPath);
                if (!folderExists) {
                  await this.app.vault.createFolder(currentFolderPath);
                }
              }
            }

            // Download and write file
            const downloadRes = await fetch(
              `${this.settings.serverUrl}/api/workspaces/${this.settings.workspaceId}/attachments/download?filepath=${encodeURIComponent(normalizedAttachPath)}`,
              {
                headers: {
                  'Authorization': `Bearer ${this.settings.token}`
                }
              }
            );
            if (downloadRes.ok) {
              const arrayBuffer = await downloadRes.arrayBuffer();
              this.isApplyingRemoteUpdate = true;
              this.addProgrammedModification(normalizedAttachPath);
              try {
                await this.writeLocalBinary(normalizedAttachPath, arrayBuffer);
                this.logEvent('success', `Downloaded ${localFile ? 'modified' : 'missing'} attachment "${normalizedAttachPath}"`);
                this.settings.syncHashes[normalizedAttachPath] = attach.hash;
                this.downloadedFilesCooldown.set(normalizedAttachPath.toLowerCase(), Date.now());
                downloadedCount++;
              } catch (e: any) {
                this.deleteProgrammedModification(normalizedAttachPath);
                this.logEvent('error', `Failed to write binary file "${normalizedAttachPath}": ${e.message || e}`);
                errors.push(`Failed to write binary file "${normalizedAttachPath}": ${e.message || e}`);
              } finally {
                this.isApplyingRemoteUpdate = false;
              }
            } else {
              this.logEvent('error', `Failed to download attachment "${attach.filepath}": HTTP ${downloadRes.status}`);
              errors.push(`Failed to download attachment "${attach.filepath}": HTTP ${downloadRes.status}`);
            }
          }
        } catch (err: any) {
          this.logEvent('error', `Failed to download attachment "${attach.filepath}": ${err.message || err}`);
          errors.push(`Failed to download attachment "${attach.filepath}": ${err.message || err}`);
        }
      }

      await this.saveData(this.settings);
      this.verifyActiveFileMapping();
      this.updateSidebarViews();
      
      const runEvents = this.currentSyncRunEvents || [];

      const hasChanges = uploadedCount > 0 || downloadedCount > 0 || deletedCount > 0 || reconciledCount > 0 || errors.length > 0;
      
      if (hasChanges) {
        // Write sync logs to cosync-sync-log.md
        const timestamp = new Date().toLocaleString();
        let logEntry = `### Sync Run: ${timestamp}\n`;
        logEntry += `- **Status**: ${errors.length > 0 ? 'Completed with errors ⚠️' : 'Successful ✅'}\n`;
        logEntry += `- **Files Uploaded**: ${uploadedCount}\n`;
        logEntry += `- **Files Downloaded**: ${downloadedCount}\n`;
        logEntry += `- **Files Deleted**: ${deletedCount}\n`;
        logEntry += `- **Conflicts Reconciled**: ${reconciledCount}\n`;
        if (errors.length > 0) {
          logEntry += `- **Errors (${errors.length})**:\n`;
          errors.forEach(err => {
            logEntry += `  - \`${err}\`\n`;
          });
        }
        
        // Append detailed logs of events from this run
        if (runEvents.length > 0) {
          logEntry += `- **Detailed Events**:\n`;
          runEvents.forEach(l => {
            logEntry += `  - ${l}\n`;
          });
        }
        logEntry += `\n---\n`;

        const logPath = 'cosync-sync-log.md';
        const logFile = this.app.vault.getAbstractFileByPath(logPath);
        if (logFile instanceof TFile) {
          const currentContent = await this.app.vault.read(logFile);
          await this.app.vault.modify(logFile, logEntry + '\n' + currentContent);
        } else {
          await this.app.vault.create(logPath, `# CoSync Sync Logs\n\n` + logEntry);
        }
      }

      // Clean empty folders if any files were deleted during sync
      if (filesDeletedDuringSync.size > 0) {
        await this.cleanEmptyFolders(filesDeletedDuringSync);
      }

      this.logEvent(
        errors.length > 0 ? 'warn' : 'success', 
        `Synchronization complete. Uploads: ${uploadedCount}, Downloads: ${downloadedCount}, Deletions: ${deletedCount}`
      );
      
      if (this.wsProvider?.wsconnected) {
        this.updateStatusBar('connected');
      } else {
        this.updateStatusBar('disconnected');
      }

      if (isManual || uploadedCount > 0 || downloadedCount > 0 || deletedCount > 0 || errors.length > 0) {
        let msg = `CoSync Sync complete.`;
        if (uploadedCount > 0 || downloadedCount > 0 || deletedCount > 0) {
          msg += ` Uploaded: ${uploadedCount}, Downloaded: ${downloadedCount}, Deleted: ${deletedCount}.`;
        } else {
          msg += ` No changes detected.`;
        }
        if (errors.length > 0) {
          msg += ` (Errors: ${errors.length}. Checked cosync-sync-log.md)`;
        }
        new Notice(msg);
      }
    } catch (err: any) {
      this.logEvent('error', `Fatal sync error: ${err.message || err}`);
      errors.push(`Fatal sync error: ${err.message || err}`);
      
      const runEvents = this.currentSyncRunEvents || [];
      const timestamp = new Date().toLocaleString();
      let logEntry = `### Sync Run: ${timestamp}\n`;
      logEntry += `- **Status**: Fatal Error ❌\n`;
      logEntry += `- \`${err.message || err}\`\n`;
      if (runEvents.length > 0) {
        logEntry += `- **Detailed Events**:\n`;
        runEvents.forEach(l => {
          logEntry += `  - ${l}\n`;
        });
      }
      logEntry += `\n---\n`;

      const logPath = 'cosync-sync-log.md';
      try {
        const logFile = this.app.vault.getAbstractFileByPath(logPath);
        if (logFile instanceof TFile) {
          const currentContent = await this.app.vault.read(logFile);
          await this.app.vault.modify(logFile, logEntry + '\n' + currentContent);
        } else {
          await this.app.vault.create(logPath, `# CoSync Sync Logs\n\n` + logEntry);
        }
      } catch (logErr) {
        console.error('Failed to write fatal sync error to log file:', logErr);
      }

      new Notice(`CoSync Sync Failed: ${err.message || err}`);
      this.updateStatusBar('disconnected');
    } finally {
      this.isSyncing = false;
      this.currentSyncRunEvents = null;
    }
  }

  private async reconcileBackgroundDoc(
    file: TFile,
    docId: string,
    isMarkdown: boolean,
    localContent: string,
    localHash: string,
    lastSyncedHash: string | undefined,
    serverVersion: number
  ): Promise<string> {
    const wsUrl = this.settings.serverUrl.replace(/^http/, 'ws');
    const roomName = `workspace/${this.settings.workspaceId}/doc/${docId}`;
    const tempYDoc = new Y.Doc();
    const ytext = tempYDoc.getText('codemirror');

    const tempWs = new WebsocketProvider(wsUrl, roomName, tempYDoc, {
      connect: true,
      protocols: ['co-sync-auth', this.settings.token]
    });

    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        tempWs.disconnect();
        tempWs.destroy();
        tempYDoc.destroy();
        reject(new Error("Sync timed out (8s limit reached)"));
      }, 8000);

      tempWs.on('sync', async (isSynced: boolean) => {
        if (isSynced && tempYDoc) {
          clearTimeout(timeout);
          let outcome = 'none';
          try {
            const serverContent = ytext.toString();
            const serverContentWithId = isMarkdown ? stripCosyncId(serverContent) : serverContent;
            const serverHash = getContentHash(serverContentWithId);

            if (!lastSyncedHash) {
              // First time sync
              if (serverContent === '') {
                tempYDoc.transact(() => {
                  ytext.insert(0, localContent);
                }, 'local-init');
                this.settings.syncHashes[docId] = localHash;
                this.settings.syncVersions[docId] = serverVersion;
                outcome = 'uploaded';
              } else {
                if (localContent !== serverContentWithId) {
                  this.isApplyingRemoteUpdate = true;
                  this.addProgrammedModification(file.path);
                  try {
                    await this.app.vault.modify(file, serverContentWithId);
                    outcome = 'downloaded';
                  } catch (e) {
                    this.deleteProgrammedModification(file.path);
                    throw e;
                  } finally {
                    this.isApplyingRemoteUpdate = false;
                  }
                }
                await this.markDocumentSynced(docId, serverContentWithId, serverHash);
                this.settings.syncVersions[docId] = serverVersion;
              }
            } else {
              const lastSyncedVersion = this.settings.syncVersions[docId] || 0;
              if (localContent === serverContentWithId) {
                await this.markDocumentSynced(docId, localContent, localHash);
                this.settings.syncVersions[docId] = Math.max(serverVersion, lastSyncedVersion);
                outcome = 'none';
              } else {
                const isServerReset = serverVersion < lastSyncedVersion;
                const localChanged = (localHash !== lastSyncedHash) || isServerReset;
                const serverChanged = !isServerReset && (serverHash !== lastSyncedHash);

                if (localChanged && !serverChanged) {
                tempYDoc.transact(() => {
                  updateYTextCleanly(ytext, localContent);
                }, 'local-reconciliation-upload');
                await this.markDocumentSynced(docId, localContent, localHash);
                this.settings.syncVersions[docId] = serverVersion;
                outcome = 'uploaded';
              } else if (!localChanged && serverChanged) {
                this.isApplyingRemoteUpdate = true;
                this.addProgrammedModification(file.path);
                try {
                  await this.app.vault.modify(file, serverContentWithId);
                  outcome = 'downloaded';
                } catch (e) {
                  this.deleteProgrammedModification(file.path);
                  throw e;
                } finally {
                  this.isApplyingRemoteUpdate = false;
                }
                await this.markDocumentSynced(docId, serverContentWithId, serverHash);
                this.settings.syncVersions[docId] = serverVersion;
              } else if (localChanged && serverChanged) {
                console.log(`CoSync: Conflict detected on background file "${file.path}"! Attempting automated 3-way merge...`);
                const baseText = await this.readBaseText(docId);

                if (baseText !== null && baseText !== '') {
                  tempYDoc.transact(() => {
                    applyDiff(ytext, baseText, localContent);
                  }, 'local-reconciliation-merge');

                  const mergedContent = ytext.toString();
                  const mergedContentWithId = isMarkdown ? stripCosyncId(mergedContent) : mergedContent;
                  const mergedHash = getContentHash(mergedContentWithId);

                  this.isApplyingRemoteUpdate = true;
                  this.addProgrammedModification(file.path);
                  try {
                    await this.app.vault.modify(file, mergedContentWithId);
                    outcome = 'merged';
                  } catch (e) {
                    this.deleteProgrammedModification(file.path);
                    throw e;
                  } finally {
                    this.isApplyingRemoteUpdate = false;
                  }
                  await this.markDocumentSynced(docId, mergedContentWithId, mergedHash);
                  this.settings.syncVersions[docId] = serverVersion;
                  console.log(`CoSync: Automatically merged background changes successfully.`);
                } else {
                  // No base text found (fallback): append local edits at bottom
                  console.log(`CoSync: No base text cache found for background file. Appending local version.`);
                  const separator = `\n\n%% CoSync Conflict Merge Suffix %%\n${localContent}\n`;
                  const mergedContentWithId = serverContentWithId + separator;
                  const mergedHash = getContentHash(mergedContentWithId);

                  // Update Yjs text to match merged
                  tempYDoc.transact(() => {
                    updateYTextCleanly(ytext, mergedContentWithId);
                  }, 'local-reconciliation-merge-fallback');

                  this.isApplyingRemoteUpdate = true;
                  this.addProgrammedModification(file.path);
                  try {
                    await this.app.vault.modify(file, mergedContentWithId);
                    outcome = 'merged';
                  } catch (e) {
                    this.deleteProgrammedModification(file.path);
                    throw e;
                  } finally {
                    this.isApplyingRemoteUpdate = false;
                  }
                  await this.markDocumentSynced(docId, mergedContentWithId, mergedHash);
                  this.settings.syncVersions[docId] = serverVersion;
                }
              }
            }
          }
        } catch (err) {
            tempWs.disconnect();
            tempWs.destroy();
            tempYDoc.destroy();
            reject(err);
            return;
          }

          setTimeout(() => {
            tempWs.disconnect();
            tempWs.destroy();
            tempYDoc.destroy();
            resolve(outcome);
          }, 150);
        }
      });
    });
  }

  private async downloadNewDocFromServer(docId: string, filepath: string, isMarkdown: boolean): Promise<void> {
    const normalizedPath = filepath.normalize('NFC');
    const wsUrl = this.settings.serverUrl.replace(/^http/, 'ws');
    const roomName = `workspace/${this.settings.workspaceId}/doc/${docId}`;
    const tempYDoc = new Y.Doc();
    const tempWs = new WebsocketProvider(wsUrl, roomName, tempYDoc, {
      connect: true,
      protocols: ['co-sync-auth', this.settings.token]
    });
    const ytext = tempYDoc.getText('codemirror');

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        tempWs.disconnect();
        tempWs.destroy();
        tempYDoc.destroy();
        resolve();
      }, 8000);

      tempWs.on('sync', async (isSynced: boolean) => {
        if (isSynced) {
          clearTimeout(timeout);
          const fileContent = ytext.toString();

          const pathParts = normalizedPath.split('/');
          if (pathParts.length > 1) {
            let currentFolderPath = '';
            for (let i = 0; i < pathParts.length - 1; i++) {
              currentFolderPath = currentFolderPath ? `${currentFolderPath}/${pathParts[i]}` : pathParts[i];
              const folderExists = this.app.vault.getAbstractFileByPath(currentFolderPath);
              if (!folderExists) {
                await this.app.vault.createFolder(currentFolderPath);
              }
            }
          }

          const initialText = isMarkdown ? stripCosyncId(fileContent) : fileContent;

          // Skip creating file if it is an empty Untitled document
          const fileName = normalizedPath.split('/').pop()?.toLowerCase() || '';
          if (fileName.startsWith('untitled') && initialText.trim() === '') {
            console.log(`CoSync: Skipping download of empty Untitled server doc ${normalizedPath}`);
            tempWs.disconnect();
            tempWs.destroy();
            tempYDoc.destroy();
            resolve();
            return;
          }

          this.isApplyingRemoteUpdate = true;
          this.addProgrammedModification(normalizedPath);
          try {
            await this.app.vault.create(normalizedPath, initialText);
            const newHash = getContentHash(initialText);
            await this.markDocumentSynced(docId, initialText, newHash);
            this.settings.fileMappings[normalizedPath] = docId;
            this.verifyActiveFileMapping();
            this.updateSidebarViews();
          } catch (err) {
            this.deleteProgrammedModification(normalizedPath);
            console.error(`Failed to create new downloaded note ${normalizedPath}`, err);
          } finally {
            this.isApplyingRemoteUpdate = false;
          }

          tempWs.disconnect();
          tempWs.destroy();
          tempYDoc.destroy();
          resolve();
        }
      });
    });
  }

  public getConnectionStatus() {
    return this.currentStatus;
  }

  public getActiveFile() {
    return this.activeFile;
  }

  public getActiveDocumentId() {
    return this.activeDocumentId;
  }

  public getCollaborators() {
    if (!this.wsProvider || !this.wsProvider.awareness) return [];
    const states = this.wsProvider.awareness.getStates();
    const collaboratorMap = new Map<string, { name: string; color: string; isSelf: boolean }>();
    const localClientId = this.wsProvider.awareness.clientID;
    
    for (const [clientId, state] of states.entries()) {
      const user = state.user;
      if (user && typeof user === 'object') {
        const name = (user as any).name || (user as any).username || 'Anonymous';
        const color = (user as any).color || '#E91E63';
        const isSelf = clientId === localClientId;
        
        const existing = collaboratorMap.get(name);
        if (!existing || isSelf) {
          collaboratorMap.set(name, { name, color, isSelf });
        }
      }
    }
    return Array.from(collaboratorMap.values());
  }

  public async manualCaptureVersion() {
    if (!this.activeDocumentId) return null;
    try {
      const response = await fetch(`${this.settings.serverUrl}/api/documents/${this.activeDocumentId}/versions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.settings.token}`
        }
      });
      if (response.ok) {
        return await response.json();
      } else {
        const errorData = await response.json();
        throw new Error(errorData.error || response.statusText);
      }
    } catch (err) {
      console.error('CoSync: Failed manual capture version', err);
      throw err;
    }
  }

  async activateView() {
    const { workspace } = this.app;

    let leaf = workspace.getLeavesOfType(COSYNC_VIEW_TYPE)[0];
    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        leaf = rightLeaf;
        await leaf.setViewState({
          type: COSYNC_VIEW_TYPE,
          active: true
        });
      }
    }
    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

}

// Settings dashboard
class CoSyncSettingTab extends PluginSettingTab {
  plugin: CoSyncPlugin;

  constructor(app: App, plugin: CoSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'CoSync Settings' });

    // 1. Server Address
    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('The address of your self-hosted CoSync API server.')
      .addText(text => text
        .setPlaceholder('https://cosync-api.3lmagary.com')
        .setValue(this.plugin.settings.serverUrl || '')
        .onChange(async (value) => {
          let cleanedUrl = value.trim();
          while (cleanedUrl.endsWith('/')) {
            cleanedUrl = cleanedUrl.slice(0, -1);
          }
          this.plugin.settings.serverUrl = cleanedUrl;
          await this.plugin.saveSettings();
          await this.plugin.reconnect();
        }));

    // 2. Connection Code / Token
    new Setting(containerEl)
      .setName('Connection Code')
      .setDesc('Enter the Connection Code (Pre-shared Key) configured on your server.')
      .addText(text => text
        .setPlaceholder('Enter connection code here...')
        .setValue(this.plugin.settings.token || '')
        .onChange(async (value) => {
          this.plugin.settings.token = value.trim();
          this.plugin.settings.workspaceId = 'default-workspace'; // force single-workspace mode
          await this.plugin.saveSettings();
          await this.plugin.reconnect();
        }));

    // 3. Device Name
    new Setting(containerEl)
      .setName('Device Name')
      .setDesc('Name of this device (e.g. PC, Tablet, Phone) to show who is editing.')
      .addText(text => text
        .setPlaceholder('PC')
        .setValue(this.plugin.settings.displayName || '')
        .onChange(async (value) => {
          this.plugin.settings.displayName = value.trim() || 'Obsidian User';
          await this.plugin.saveSettings();
          // Update awareness state on the fly
          if (this.plugin.wsProvider) {
            this.plugin.wsProvider.awareness.setLocalStateField('user', {
              name: this.plugin.settings.displayName,
              color: getDeterministicColor(this.plugin.settings.displayName),
              userId: 'obsidian-client'
            });
          }
        }));

    containerEl.createEl('h3', { text: 'Background Synchronization' });

    new Setting(containerEl)
      .setName('Enable Background Sync')
      .setDesc('Automatically synchronize all notes and attachments in the background.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableBackgroundSync)
        .onChange(async (value) => {
          this.plugin.settings.enableBackgroundSync = value;
          await this.plugin.saveSettings();
          this.plugin.startPeriodicSync();
        }));

    new Setting(containerEl)
      .setName('Sync Interval (seconds)')
      .setDesc('How often (in seconds) the background synchronization should run.')
      .addText(text => text
        .setPlaceholder('30')
        .setValue(String(this.plugin.settings.syncInterval))
        .onChange(async (value) => {
          const val = parseInt(value.trim(), 10);
          if (!isNaN(val) && val >= 0) {
            this.plugin.settings.syncInterval = val;
            await this.plugin.saveSettings();
            this.plugin.startPeriodicSync();
          }
        }));

    containerEl.createEl('h3', { text: 'Vault Customization & Configuration' });

    new Setting(containerEl)
      .setName('Sync Obsidian Configuration')
      .setDesc('Synchronize appearance settings, themes, custom hotkeys, and active plugins list across devices.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.syncConfig || false)
        .onChange(async (value) => {
          this.plugin.settings.syncConfig = value;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl('h3', { text: 'Vault Synchronization' });

    new Setting(containerEl)
      .setName('Sync Local Vault Now')
      .setDesc('Force a full synchronization check immediately.')
      .addButton(btn => btn
        .setButtonText('Sync Entire Vault Now')
        .setCta()
        .onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText('Syncing...');
          try {
            await this.plugin.syncEntireVault();
          } finally {
            btn.setDisabled(false);
            btn.setButtonText('Sync Entire Vault Now');
          }
        }));
  }
}

function stripCosyncId(content: string): string {
  const cleanContent = content.replace(/^\uFEFF/, '');
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
  const match = cleanContent.match(frontmatterRegex);
  
  if (match) {
    const innerContent = match[1];
    const lines = innerContent.split(/\r?\n/);
    const otherFrontmatterLines = lines.filter(line => {
      const trimmed = line.trim();
      return trimmed && !trimmed.startsWith('cosyncId:');
    });
    
    const body = cleanContent.replace(frontmatterRegex, '');
    
    if (otherFrontmatterLines.length > 0) {
      return `---\n${otherFrontmatterLines.join('\n')}\n---\n\n${body.trim()}`;
    } else {
      return body.trim();
    }
  } else {
    // Only strip if it is at the start of a line to avoid false positives inside user text
    return cleanContent.replace(/^cosyncId:\s*[^\r\n]+(?:\r?\n|$)/gm, '').trim();
  }
}

function getContentHash(str: string): string {
  const cleanStr = stripCosyncId(str);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0, ch; i < cleanStr.length; i++) {
    ch = cleanStr.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

function getBinaryHash(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0, val; i < view.length; i++) {
    val = view[i];
    h1 = Math.imul(h1 ^ val, 2654435761);
    h2 = Math.imul(h2 ^ val, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

function updateYTextCleanly(ytext: Y.Text, newText: string) {
  const normalizedNewText = newText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const oldText = ytext.toString().replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (oldText === normalizedNewText) return;

  let commonPrefixLen = 0;
  const maxLen = Math.min(oldText.length, normalizedNewText.length);
  while (commonPrefixLen < maxLen && oldText[commonPrefixLen] === normalizedNewText[commonPrefixLen]) {
    commonPrefixLen++;
  }
  // Prevent splitting surrogate pairs at the end of the prefix
  if (commonPrefixLen > 0 && commonPrefixLen < oldText.length) {
    const prevCode = oldText.charCodeAt(commonPrefixLen - 1);
    if (prevCode >= 0xD800 && prevCode <= 0xDBFF) {
      commonPrefixLen--;
    }
  }

  let commonSuffixLen = 0;
  const maxSuffixLen = maxLen - commonPrefixLen;
  while (
    commonSuffixLen < maxSuffixLen &&
    oldText[oldText.length - 1 - commonSuffixLen] === normalizedNewText[normalizedNewText.length - 1 - commonSuffixLen]
  ) {
    commonSuffixLen++;
  }
  // Prevent splitting surrogate pairs at the start of the suffix
  if (commonSuffixLen > 0 && commonSuffixLen < oldText.length) {
    const suffixStartCode = oldText.charCodeAt(oldText.length - commonSuffixLen);
    if (suffixStartCode >= 0xDC00 && suffixStartCode <= 0xDFFF) {
      commonSuffixLen--;
    }
  }

  const deleteCount = oldText.length - commonPrefixLen - commonSuffixLen;
  const insertText = normalizedNewText.substring(commonPrefixLen, normalizedNewText.length - commonSuffixLen);

  if (deleteCount > 0 || insertText.length > 0) {
    ytext.delete(commonPrefixLen, deleteCount);
    ytext.insert(commonPrefixLen, insertText);
  }
}

function applyDiff(ytext: Y.Text, baseText: string, newText: string) {
  const normalizedBase = baseText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const normalizedNew = newText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (normalizedBase === normalizedNew) return;

  let commonPrefixLen = 0;
  const maxLen = Math.min(normalizedBase.length, normalizedNew.length);
  while (commonPrefixLen < maxLen && normalizedBase[commonPrefixLen] === normalizedNew[commonPrefixLen]) {
    commonPrefixLen++;
  }

  // Prevent splitting surrogate pairs at the end of the prefix
  if (commonPrefixLen > 0 && commonPrefixLen < normalizedBase.length) {
    const prevCode = normalizedBase.charCodeAt(commonPrefixLen - 1);
    if (prevCode >= 0xD800 && prevCode <= 0xDBFF) {
      commonPrefixLen--;
    }
  }

  let commonSuffixLen = 0;
  const maxSuffixLen = maxLen - commonPrefixLen;
  while (
    commonSuffixLen < maxSuffixLen &&
    normalizedBase[normalizedBase.length - 1 - commonSuffixLen] === normalizedNew[normalizedNew.length - 1 - commonSuffixLen]
  ) {
    commonSuffixLen++;
  }

  // Prevent splitting surrogate pairs at the start of the suffix
  if (commonSuffixLen > 0 && commonSuffixLen < normalizedBase.length) {
    const suffixStartCode = normalizedBase.charCodeAt(normalizedBase.length - commonSuffixLen);
    if (suffixStartCode >= 0xDC00 && suffixStartCode <= 0xDFFF) {
      commonSuffixLen--;
    }
  }

  const deleteCount = normalizedBase.length - commonPrefixLen - commonSuffixLen;
  const insertText = normalizedNew.substring(commonPrefixLen, normalizedNew.length - commonSuffixLen);

  if (deleteCount > 0 || insertText.length > 0) {
    if (deleteCount > 0) {
      ytext.delete(commonPrefixLen, deleteCount);
    }
    if (insertText.length > 0) {
      ytext.insert(commonPrefixLen, insertText);
    }
  }
}

const COSYNC_VIEW_TYPE = 'cosync-collaboration-view';

class CoSyncView extends ItemView {
  private plugin: CoSyncPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: CoSyncPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return COSYNC_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'CoSync Collaboration';
  }

  getIcon(): string {
    return 'users';
  }

  async onOpen() {
    this.render();
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => this.render())
    );
  }

  async onClose() {
    // Cleanup if needed
  }

  public render() {
    const container = this.contentEl;
    container.empty();
    container.addClass('cosync-sidebar-view');

    // Header title
    const header = container.createEl('div', { cls: 'cosync-sidebar-header' });
    header.createEl('h3', { text: 'CoSync Collab' });

    // Status pill
    const status = this.plugin.getConnectionStatus();
    const statusCard = container.createEl('div', { cls: 'cosync-status-card' });
    const statusDot = statusCard.createEl('span', { cls: `cosync-status-dot status-${status}` });
    const statusText = statusCard.createEl('span', { cls: 'cosync-status-text' });

    if (status === 'connected') {
      statusText.textContent = 'Connected';
    } else if (status === 'connecting') {
      statusText.textContent = 'Connecting...';
    } else if (status === 'disconnected') {
      statusText.textContent = 'Offline';
    } else if (status === 'syncing') {
      statusText.textContent = 'Syncing...';
    }

    // Quick Actions
    const quickActions = container.createEl('div', { cls: 'cosync-quick-actions' });
    
    const syncBtn = quickActions.createEl('button', { cls: 'cosync-quick-btn accent', text: '🔄 Sync Now' });
    syncBtn.addEventListener('click', () => {
      this.plugin.syncEntireVault();
    });

    const reconnectBtn = quickActions.createEl('button', { cls: 'cosync-quick-btn', text: '⚡ Reconnect' });
    reconnectBtn.addEventListener('click', () => {
      this.plugin.reconnect();
    });

    // Active Note Info
    const activeFile = this.plugin.getActiveFile();
    const docSection = container.createEl('div', { cls: 'cosync-section' });
    docSection.createEl('h4', { text: 'Active Note' });
    const docInfo = docSection.createEl('div', { cls: 'cosync-doc-info' });

    if (activeFile) {
      const docTitle = docInfo.createEl('div', { cls: 'cosync-doc-title' });
      docTitle.createEl('span', { text: '📄 ', cls: 'cosync-doc-icon' });
      docTitle.createEl('span', { text: activeFile.basename, cls: 'cosync-doc-name' });
    } else {
      docInfo.createEl('div', { cls: 'cosync-doc-title empty', text: 'No note open' });
    }

    // Collaborators list
    const collaboratorsSection = container.createEl('div', { cls: 'cosync-section' });
    collaboratorsSection.createEl('h4', { text: 'Active Collaborators' });
    const listEl = collaboratorsSection.createEl('div', { cls: 'cosync-collaborators-list' });

    const collaborators = this.plugin.getCollaborators();
    if (collaborators.length > 0) {
      collaborators.forEach(user => {
        const userRow = listEl.createEl('div', { cls: 'cosync-user-row' });

        const avatar = userRow.createEl('div', { cls: 'cosync-user-avatar' });
        avatar.style.backgroundColor = user.color;
        avatar.textContent = user.name.charAt(0).toUpperCase();

        const nameSpan = userRow.createEl('span', { cls: 'cosync-user-name' });
        nameSpan.textContent = user.name;

        if (user.isSelf) {
          userRow.createEl('span', { cls: 'cosync-self-badge', text: 'you' });
        }
      });
    } else {
      listEl.createEl('div', { cls: 'cosync-no-collaborators', text: 'No other collaborators' });
    }

    // Capture version button
    if (activeFile && status === 'connected') {
      const actionsSection = container.createEl('div', { cls: 'cosync-actions-section' });
      const captureBtn = actionsSection.createEl('button', { cls: 'cosync-btn btn-primary', text: 'Capture Version' });
      captureBtn.addEventListener('click', async () => {
        captureBtn.disabled = true;
        captureBtn.textContent = 'Capturing...';
        try {
          await this.plugin.manualCaptureVersion();
          new Notice('Version captured successfully!');
        } catch (err: any) {
          new Notice(`Failed to capture version: ${err.message}`);
        } finally {
          captureBtn.disabled = false;
          captureBtn.textContent = 'Capture Version';
        }
      });
    }

    // Recent Sync Logs Panel (Useful details for user debugging)
    const logsSection = container.createEl('div', { cls: 'cosync-section' });
    const logsHeader = logsSection.createEl('div', { cls: 'cosync-logs-header' });
    logsHeader.createEl('h4', { text: 'Sync Activity Log' });
    
    const clearLogs = logsHeader.createEl('span', { cls: 'cosync-logs-clear', text: 'Clear' });
    clearLogs.addEventListener('click', () => {
      this.plugin.recentLogs = [];
      this.render();
    });

    const logsPanel = logsSection.createEl('div', { cls: 'cosync-logs-panel' });
    
    if (this.plugin.recentLogs.length > 0) {
      this.plugin.recentLogs.forEach(log => {
        const row = logsPanel.createEl('div', { cls: 'cosync-log-row' });
        
        const time = row.createEl('span', { cls: 'cosync-log-time', text: log.timestamp });
        
        const text = row.createEl('span', { 
          cls: `cosync-log-text log-${log.level}`, 
          text: log.message 
        });
      });
    } else {
      const emptyRow = logsPanel.createEl('div', { 
        cls: 'cosync-log-row', 
        text: 'No sync activity yet.' 
      });
      emptyRow.style.cssText = 'color: var(--text-muted); font-style: italic; text-align: center; margin-top: 20px;';
    }
  }
}

export = CoSyncPlugin;
