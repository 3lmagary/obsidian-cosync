import { Plugin, MarkdownView, TFile, PluginSettingTab, App, Setting, Notice } from 'obsidian';
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
  fileMappings: Record<string, string>;
}

const DEFAULT_SETTINGS: CoSyncSettings = {
  serverUrl: 'http://localhost:4000',
  token: '',
  workspaceId: 'ws-default',
  connectionCode: '',
  syncHashes: {},
  fileMappings: {}
};

class CoSyncPlugin extends Plugin {
  settings!: CoSyncSettings;
  
  // Collaborative state variables
  private ydoc: Y.Doc | null = null;
  private wsProvider: WebsocketProvider | null = null;
  private activeFile: TFile | null = null;
  private activeDocumentId: string | null = null;
  
  // Safeguard flag to avoid infinite update loops
  private isApplyingRemoteUpdate = false;
  // Programmatic modifications tracker to prevent loopbacks from vault.modify events
  private programmedModifications: Set<string> = new Set();
  
  // CodeMirror 6 configuration compartment
  private yjsCompartment = new Compartment();

  private syncTimer: NodeJS.Timeout | null = null;
  private syncTimeout: NodeJS.Timeout | null = null;
  private statusBarEl: HTMLElement | null = null;

  private updateStatusBar(status: 'connected' | 'connecting' | 'disconnected' | 'syncing', customText?: string) {
    if (!this.statusBarEl) return;
    
    this.statusBarEl.empty();
    
    const container = this.statusBarEl.createEl('div', { cls: 'cosync-status-bar' });
    container.style.display = 'flex';
    container.style.alignItems = 'center';
    container.style.gap = '6px';
    container.style.cursor = 'pointer';
    container.title = 'Obsidian CoSync Status';
    
    const dot = container.createEl('span');
    dot.style.width = '8px';
    dot.style.height = '8px';
    dot.style.borderRadius = '50%';
    dot.style.display = 'inline-block';
    
    const text = container.createEl('span');
    text.style.fontSize = '12px';
    text.style.fontWeight = '500';
    
    if (status === 'connected') {
      dot.style.backgroundColor = '#10b981'; // Green
      text.textContent = customText || 'CoSync: Connected';
    } else if (status === 'connecting') {
      dot.style.backgroundColor = '#f59e0b'; // Yellow
      text.textContent = customText || 'CoSync: Connecting';
    } else if (status === 'disconnected') {
      dot.style.backgroundColor = '#ef4444'; // Red
      text.textContent = customText || 'CoSync: Offline';
    } else if (status === 'syncing') {
      dot.style.backgroundColor = '#3b82f6'; // Blue
      text.textContent = customText || 'CoSync: Syncing ⬆️';
    }
  }

  async onload() {
    console.log('Loading Obsidian CoSync Plugin...');
    await this.loadSettings();

    // Register setting tab
    this.addSettingTab(new CoSyncSettingTab(this.app, this));

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

    // Monitor external file modifications (Git, VSCode, other sync tools)
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile) {
          this.handleExternalModification(file);
        }
      })
    );

    // Monitor file renames/moves to keep mappings up to date
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFile && this.settings.fileMappings?.[oldPath]) {
          this.settings.fileMappings[file.path] = this.settings.fileMappings[oldPath];
          delete this.settings.fileMappings[oldPath];
          this.saveSettings();
        }
      })
    );

    // Initial check
    this.handleFileSwitch();

    // Start periodic check for new documents from server (every 15 seconds)
    this.syncTimer = setInterval(() => this.syncNewDocumentsFromServer(), 15000);
    // Also run once immediately on load
    setTimeout(() => this.syncNewDocumentsFromServer(), 1000);
  }

  onunload() {
    console.log('Unloading CoSync Plugin...');
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
        const yContentWithId = injectCosyncId(yContent, this.activeDocumentId!);
        if (normalizeText(yContentWithId) !== normalizeText(currentContent)) {
          this.isApplyingRemoteUpdate = true;
          this.programmedModifications.add(this.activeFile.path);
          try {
            await this.app.vault.modify(this.activeFile, yContentWithId);
          } catch (err) {
            this.programmedModifications.delete(this.activeFile.path);
            throw err;
          } finally {
            this.isApplyingRemoteUpdate = false;
          }
          
          if (this.activeDocumentId) {
            this.settings.syncHashes[this.activeDocumentId] = getContentHash(yContentWithId);
            await this.saveSettings();
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
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const editor = activeView?.editor as any;
    if (editor && editor.cm) {
      const cmView = editor.cm as EditorView;
      try {
        cmView.dispatch({
          effects: this.yjsCompartment.reconfigure([])
        });
      } catch (err) {
        console.error('Error clearing CodeMirror compartment:', err);
      }
    }
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

  /**
   * Resolves the CoSync document ID for a given file.
   * 1. Checks frontmatter for 'cosyncId'.
   * 2. If not found, fetches workspace documents from server and looks for a matching title.
   * 3. If found, writes it to frontmatter.
   * 4. If not found, creates a new document on server and writes it to frontmatter.
   */
  private async resolveDocumentId(file: TFile): Promise<string> {
    try {
      if (!this.settings.fileMappings) {
        this.settings.fileMappings = {};
      }

      // Load server documents first to verify if they exist
      const response = await fetch(`${this.settings.serverUrl}/api/workspaces/${this.settings.workspaceId}/documents`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.settings.token}`
        }
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch documents: ${response.statusText}`);
      }

      const documents: any[] = await response.json();
      const serverDocIdSet = new Set(documents.map((d: any) => d.id));
      const title = file.path.endsWith('.md') ? file.path.slice(0, -3) : file.path;
      const matchByTitle = documents.find((d: any) => d.title.trim().toLowerCase() === title.trim().toLowerCase());

      // 1. Check settings mapping
      let docId = this.settings.fileMappings[file.path];
      if (docId && serverDocIdSet.has(docId)) {
        // Exists on server, rename if title changed
        const currentTitle = file.path.endsWith('.md') ? file.path.slice(0, -3) : file.path;
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
        this.settings.fileMappings[file.path] = existingId;
        await this.saveSettings();
        return existingId;
      }

      // 3. Match by title
      if (matchByTitle) {
        docId = matchByTitle.id;
        console.log(`CoSync: Found matching document on server by title: ${title} (${docId})`);
        this.settings.fileMappings[file.path] = docId;
        
        // Inject / Update frontmatter to have correct server ID
        const fileContent = await this.app.vault.read(file);
        const contentWithId = injectCosyncId(fileContent, docId);
        
        this.isApplyingRemoteUpdate = true;
        this.programmedModifications.add(file.path);
        try {
          await this.app.vault.modify(file, contentWithId);
        } catch (err) {
          this.programmedModifications.delete(file.path);
        } finally {
          this.isApplyingRemoteUpdate = false;
        }

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
        throw new Error(`Failed to create document: ${createResponse.statusText}`);
      }

      const newDoc = await createResponse.json();
      docId = newDoc.id;
      console.log(`CoSync: Created new document on server: ${title} (${docId})`);
      
      const fileContent = await this.app.vault.read(file);
      const contentWithId = injectCosyncId(fileContent, docId);
      
      this.isApplyingRemoteUpdate = true;
      this.programmedModifications.add(file.path);
      try {
        await this.app.vault.modify(file, contentWithId);
      } catch (err) {
        this.programmedModifications.delete(file.path);
      } finally {
        this.isApplyingRemoteUpdate = false;
      }

      this.settings.fileMappings[file.path] = docId;
      await this.saveSettings();
      return docId;
    } catch (err) {
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
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView) {
      this.disconnectActive();
      return;
    }

    const file = activeView.file;
    if (!file || (!force && this.activeFile && this.activeFile.path === file.path)) {
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
    const documentId = await this.resolveDocumentId(file);
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
    this.wsProvider = new WebsocketProvider(wsUrl, roomName, this.ydoc, {
      connect: true,
      protocols: ['co-sync-auth', this.settings.token]
    });

    this.updateStatusBar('connecting');
    this.wsProvider.on('status', ({ status }) => {
      this.updateStatusBar(status as any);
    });

    // Configure reconnect backoff
    this.wsProvider.maxBackoffTime = 30000;

    // Set local awareness identifier
    this.wsProvider.awareness.setLocalStateField('user', {
      name: '3lmagary',
      color: '#10b981', // Emerald Cursor
      userId: 'obsidian-client'
    });

    const ytext = this.ydoc.getText('codemirror');

    // Sync remote updates from browser directly to the local note file on disk
    ytext.observe((event, transaction) => {
      // Ignore local transactions initiated by this Obsidian instance
      if (transaction && transaction.local) return;

      if (this.syncTimeout) clearTimeout(this.syncTimeout);

      // Dynamic debounce: write faster (100ms) if the user is not actively editing in Obsidian (unfocused),
      // and use a safe longer delay (1500ms) if focused to prevent interrupting active input.
      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      const isFocused = activeView && activeView.file?.path === this.activeFile?.path && activeView.editor?.hasFocus();
      const debounceDelay = isFocused ? 1500 : 100;

      this.syncTimeout = setTimeout(async () => {
        this.syncTimeout = null;
        await this.syncYDocToLocalFile();
      }, debounceDelay);
    });

    // We do not observe and modify the disk file during active typing/sync
    // because yCollab updates CodeMirror directly, and Obsidian auto-saves
    // the active CodeMirror document to disk. Manual modify triggers editor reloads.

    // Reconcile offline modifications once synced with server using a stable 3-way merge engine
    this.wsProvider.on('sync', async (isSynced: boolean) => {
      if (isSynced && this.activeFile === file && this.ydoc) {
        // SAFEGUARD: If editor has focus, yCollab keeps it in sync. Disk file might be stale.
        // Skipping disk reconciliation prevents overwriting latest typed memory state with stale autosave.
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView && activeView.file?.path === file.path && activeView.editor?.hasFocus()) {
          console.log('CoSync: Connection synced. Skipping disk reconciliation since editor is focused.');
          const currentYText = ytext.toString();
          const currentYTextWithId = injectCosyncId(currentYText, documentId);
          this.settings.syncHashes[documentId] = getContentHash(currentYTextWithId);
          await this.saveSettings();
          return;
        }

        const serverContent = ytext.toString();
        const serverContentWithId = injectCosyncId(serverContent, documentId);
        const serverHash = getContentHash(serverContentWithId);
        const localContent = await this.app.vault.read(file);
        const localHash = getContentHash(localContent);
        const lastSyncedHash = this.settings.syncHashes[documentId];

        if (!lastSyncedHash) {
          // Case A: First time sync
          if (serverContent === '') {
            // Server is empty, initialize it with local content
            this.ydoc.transact(() => {
              ytext.insert(0, localContent);
            }, 'local-init');
            this.settings.syncHashes[documentId] = localHash;
            await this.saveSettings();
            console.log(`CoSync: Initialized empty server document with local content.`);
          } else {
            // Server has content, local has content. Overwrite local with server (Server is authority)
            if (localContent !== serverContentWithId) {
              this.isApplyingRemoteUpdate = true;
              this.programmedModifications.add(file.path);
              try {
                await this.app.vault.modify(file, serverContentWithId);
              } catch (err) {
                this.programmedModifications.delete(file.path);
                throw err;
              } finally {
                this.isApplyingRemoteUpdate = false;
              }
            }
            this.settings.syncHashes[documentId] = serverHash;
            await this.saveSettings();
            console.log(`CoSync: Initialized local document with server content.`);
          }
        } else {
          // Case B: Subsequent sync (3-way merge)
          const localChanged = localHash !== lastSyncedHash;
          const serverChanged = serverHash !== lastSyncedHash;

          if (localChanged && !serverChanged) {
            // Only local changed: push local to server using clean diffs
            this.ydoc.transact(() => {
              updateYTextCleanly(ytext, localContent);
            }, 'local-reconciliation-push');
            this.settings.syncHashes[documentId] = localHash;
            await this.saveSettings();
            console.log(`CoSync: Pushed offline local changes to server.`);
          } else if (!localChanged && serverChanged) {
            // Only server changed: pull server to local
            this.isApplyingRemoteUpdate = true;
            this.programmedModifications.add(file.path);
            try {
              await this.app.vault.modify(file, serverContentWithId);
            } catch (err) {
              this.programmedModifications.delete(file.path);
              throw err;
            } finally {
              this.isApplyingRemoteUpdate = false;
            }
            this.settings.syncHashes[documentId] = serverHash;
            await this.saveSettings();
            console.log(`CoSync: Pulled offline remote changes from server.`);
          } else if (localChanged && serverChanged) {
            // Both changed: conflict! Merge local changes cleanly via Yjs diff, then write merged text back
            console.log(`CoSync: Conflict detected! Merging local and remote changes...`);
            this.ydoc.transact(() => {
              updateYTextCleanly(ytext, localContent);
            }, 'local-reconciliation-merge');
            
            const mergedContent = ytext.toString();
            const mergedContentWithId = injectCosyncId(mergedContent, documentId);
            const mergedHash = getContentHash(mergedContentWithId);
            
            this.isApplyingRemoteUpdate = true;
            this.programmedModifications.add(file.path);
            try {
              await this.app.vault.modify(file, mergedContentWithId);
            } catch (err) {
              this.programmedModifications.delete(file.path);
              throw err;
            } finally {
              this.isApplyingRemoteUpdate = false;
            }
            
            this.settings.syncHashes[documentId] = mergedHash;
            await this.saveSettings();
          }
        }
      }
    });

    // Sync local cursor movements to Yjs awareness relative positions
    const cursorListener = EditorView.updateListener.of((update) => {
      if (!this.wsProvider || !this.activeDocumentId) return;

      const hasFocus = update.view.hasFocus;
      if (hasFocus) {
        if (update.selectionSet || update.focusChanged) {
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
      } else if (update.focusChanged) {
        // Just lost focus, clear local cursor representation from the provider
        try {
          this.wsProvider.awareness.setLocalStateField('cursor', null);
        } catch (err) {
          console.warn('CoSync: Error clearing cursor awareness:', err);
        }
      }
    });

    // Reconfigure CodeMirror 6 with the Yjs yCollab extension and selection listener
    const extension: Extension = [
      yCollab(ytext, this.wsProvider.awareness),
      cursorListener
    ];
    
    // Inject the extension into active editor view using compartments
    const editor = activeView.editor as any;
    if (editor && editor.cm) {
      const cmView = editor.cm as EditorView;
      cmView.dispatch({
        effects: this.yjsCompartment.reconfigure(extension)
      });
    }
  }

  /**
   * Writes remote Yjs state changes back to the active vault file.
   */
  private async syncYDocToLocalFile() {
    if (!this.activeFile || !this.ydoc) return;

    // SAFEGUARD: If editor is open in Editing Mode (Source/Live Preview), CodeMirror's yCollab handles sync in-memory.
    // Writing to disk now conflicts with user input and triggers Obsidian's native external modification watcher
    // ("File modified externally, merging automatically..."), which resets selection and ruins the text.
    // We only write to disk if the note is closed/background, or open in Reading Mode (preview).
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView && activeView.file?.path === this.activeFile.path && activeView.getMode() === 'source') {
      console.log('CoSync: Skipping disk write because active editor is open in Editing Mode.');
      return;
    }
    
    const yContent = this.ydoc.getText('codemirror').toString();
    const yContentWithId = injectCosyncId(yContent, this.activeDocumentId!);

    try {
      const currentContent = await this.app.vault.read(this.activeFile);
      const normalizeText = (str: string) => str.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();

      if (normalizeText(yContentWithId) !== normalizeText(currentContent)) {
        // SAFEGUARD: Set flag so that vault.on('modify') does not treat this write
        // as a local edit transaction and recursively push it back to the server.
        this.isApplyingRemoteUpdate = true;
        this.programmedModifications.add(this.activeFile.path);
        try {
          await this.app.vault.modify(this.activeFile, yContentWithId);
        } catch (err) {
          this.programmedModifications.delete(this.activeFile.path);
          throw err;
        } finally {
          this.isApplyingRemoteUpdate = false;
        }
        
        if (this.activeDocumentId) {
          this.settings.syncHashes[this.activeDocumentId] = getContentHash(yContentWithId);
          await this.saveSettings();
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
    if (this.programmedModifications.has(file.path)) {
      this.programmedModifications.delete(file.path);
      return;
    }

    // If WebSocket is connected, yCollab handles all sync.
    // External modification check is only needed for offline reconciliation or when disconnected.
    if (this.wsProvider && this.wsProvider.wsconnected) {
      return;
    }

    // Only check if it matches our active note and is NOT a write from the remote sync listener
    if (!this.activeFile || this.activeFile.path !== file.path || this.isApplyingRemoteUpdate || !this.ydoc) {
      return;
    }

    // Safeguard: If the editor currently has focus, it means the user is editing
    // and yCollab is active. Any file writes are just autosaves, so skip syncing.
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView && activeView.file?.path === file.path && activeView.editor?.hasFocus()) {
      return;
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
          this.settings.syncHashes[this.activeDocumentId] = newHash;
          await this.saveSettings();
        }
      } else {
        // Text is identical, but file was saved to disk, so update the last synced hash to match
        if (this.activeDocumentId && this.settings.syncHashes[this.activeDocumentId] !== newHash) {
          this.settings.syncHashes[this.activeDocumentId] = newHash;
          await this.saveSettings();
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
    }
    if (!this.settings.fileMappings) {
      this.settings.fileMappings = {};
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
    this.handleFileSwitch(); // Reload connection with new configurations
  }

  async syncEntireVault() {
    try {
      const files = this.app.vault.getMarkdownFiles();
      new Notice(`CoSync: Starting synchronization of ${files.length} notes...`);
      this.updateStatusBar('syncing', `CoSync: Syncing (0/${files.length}) ⬆️`);

      // 1. Fetch server documents list once
      const response = await fetch(`${this.settings.serverUrl}/api/workspaces/${this.settings.workspaceId}/documents`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.settings.token}`
        }
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch documents from server: ${response.statusText}`);
      }

      const serverDocs: any[] = await response.json();
      const serverDocMap = new Map<string, string>();
      const serverDocIdSet = new Set<string>();
      serverDocs.forEach((d: any) => {
        serverDocMap.set(d.title.trim().toLowerCase(), d.id);
        serverDocIdSet.add(d.id);
      });

      let syncedCount = 0;
      let failedCount = 0;

      // We process files in batches of 5 to avoid API rate limiting/overload
      const BATCH_SIZE = 5;
      for (let i = 0; i < files.length; i += BATCH_SIZE) {
        const batch = files.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (file) => {
          try {
            const fileContent = await this.app.vault.read(file);
            const title = file.path.endsWith('.md') ? file.path.slice(0, -3) : file.path;
            
            // Check if mapping already exists
            let docId: string | undefined = this.settings.fileMappings?.[file.path];
            
            // Or if it is in frontmatter
            if (!docId) {
              const cache = this.app.metadataCache.getFileCache(file);
              docId = cache?.frontmatter?.['cosyncId'];
            }

            // Verify if the docId we found actually exists on the server
            const existsOnServer = docId && serverDocIdSet.has(docId);
            const serverDocIdByTitle = serverDocMap.get(title.trim().toLowerCase());

            if (existsOnServer && docId) {
              // Document already exists on server, just map it locally
              this.settings.fileMappings[file.path] = docId;
              const contentWithId = injectCosyncId(fileContent, docId);
              this.settings.syncHashes[docId] = getContentHash(contentWithId);
            } else if (serverDocIdByTitle) {
              // The local ID wasn't on the server (or was missing), but there's a document with matching title on server
              this.settings.fileMappings[file.path] = serverDocIdByTitle;
              const contentWithId = injectCosyncId(fileContent, serverDocIdByTitle);
              this.settings.syncHashes[serverDocIdByTitle] = getContentHash(contentWithId);
              // Update frontmatter to have the correct serverDocIdByTitle
              if (docId !== serverDocIdByTitle) {
                this.isApplyingRemoteUpdate = true;
                this.programmedModifications.add(file.path);
                try {
                  await this.app.vault.modify(file, contentWithId);
                } catch (err) {
                  this.programmedModifications.delete(file.path);
                  throw err;
                } finally {
                  this.isApplyingRemoteUpdate = false;
                }
              }
            } else {
              // Create document on server with initial content!
              const createResponse = await fetch(`${this.settings.serverUrl}/api/workspaces/${this.settings.workspaceId}/documents`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${this.settings.token}`
                },
                body: JSON.stringify({ title, initialContent: fileContent })
              });

              if (!createResponse.ok) {
                throw new Error(`Failed to create document: ${createResponse.statusText}`);
              }

              const newDoc = await createResponse.json();
              const newDocId = newDoc.id as string;
              
              // Inject the cosyncId frontmatter block to the local file
              const contentWithId = injectCosyncId(fileContent, newDocId);
              
              this.isApplyingRemoteUpdate = true;
              this.programmedModifications.add(file.path);
              try {
                await this.app.vault.modify(file, contentWithId);
              } catch (err) {
                this.programmedModifications.delete(file.path);
                throw err;
              } finally {
                this.isApplyingRemoteUpdate = false;
              }

              this.settings.fileMappings[file.path] = newDocId;
              this.settings.syncHashes[newDocId] = getContentHash(contentWithId);
            }

            syncedCount++;
            this.updateStatusBar('syncing', `CoSync: Syncing (${syncedCount}/${files.length}) ⬆️`);
          } catch (err) {
            console.warn(`CoSync: Failed to sync "${file.path}":`, err);
            failedCount++;
          }
        }));
        
        // Save settings after each batch
        await this.saveSettings();
      }

      new Notice(`CoSync: Vault Sync complete!\nSuccess: ${syncedCount}, Failed: ${failedCount}`);
      
      // Reset status bar back to connected if active, or offline
      if (this.wsProvider?.wsconnected) {
        this.updateStatusBar('connected');
      } else {
        this.updateStatusBar('disconnected');
      }
    } catch (err: any) {
      console.error('CoSync: Bulk sync failed:', err);
      new Notice(`CoSync: Bulk sync failed: ${err.message}`);
      this.updateStatusBar('disconnected');
    }
  }

  /**
   * Fetches all documents in the workspace from the server and creates local files
   * for any documents that do not exist locally.
   */
  private async syncNewDocumentsFromServer() {
    if (!this.settings.token || !this.settings.workspaceId) return;

    try {
      console.log('CoSync: Checking server for new/missing documents...');
      const response = await fetch(`${this.settings.serverUrl}/api/workspaces/${this.settings.workspaceId}/documents`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.settings.token}`
        }
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch documents: ${response.statusText}`);
      }

      const serverDocs: any[] = await response.json();
      const localFiles = this.app.vault.getMarkdownFiles();

      // Read all local files to build a map of existing cosyncIds and paths
      const localCosyncIds = new Set<string>();
      const localPaths = new Set<string>();

      for (const file of localFiles) {
        const localPath = file.path.endsWith('.md') ? file.path.slice(0, -3) : file.path;
        localPaths.add(localPath.toLowerCase());

        const cache = this.app.metadataCache.getFileCache(file);
        const cosyncId = cache?.frontmatter?.['cosyncId'] || this.settings.fileMappings?.[file.path];
        if (cosyncId) {
          localCosyncIds.add(cosyncId);
        }
      }

      // Identify server documents that do not exist locally
      for (const doc of serverDocs) {
        const docId = doc.id;
        const docTitle = doc.title;

        if (localCosyncIds.has(docId) || localPaths.has(docTitle.toLowerCase())) {
          continue;
        }

        console.log(`CoSync: Server document "${docTitle}" (${docId}) is missing locally. Creating...`);

        // 1. Create parent folders if they do not exist
        const pathParts = docTitle.split('/');
        if (pathParts.length > 1) {
          let currentFolderPath = '';
          for (let i = 0; i < pathParts.length - 1; i++) {
            currentFolderPath = currentFolderPath ? `${currentFolderPath}/${pathParts[i]}` : pathParts[i];
            const folderExists = this.app.vault.getAbstractFileByPath(currentFolderPath);
            if (!folderExists) {
              await this.app.vault.createFolder(currentFolderPath);
              console.log(`CoSync: Created local folder path "${currentFolderPath}"`);
            }
          }
        }

        // 2. Fetch the text content of this document from Yjs
        const wsUrl = this.settings.serverUrl.replace(/^http/, 'ws');
        const roomName = `workspace/${this.settings.workspaceId}/doc/${docId}`;
        const tempYDoc = new Y.Doc();
        const tempWs = new WebsocketProvider(wsUrl, roomName, tempYDoc, {
          connect: true,
          protocols: ['co-sync-auth', this.settings.token]
        });
        const ytext = tempYDoc.getText('codemirror');

        const fileContent = await new Promise<string>((resolve) => {
          const timeout = setTimeout(() => {
            tempWs.disconnect();
            tempWs.destroy();
            tempYDoc.destroy();
            resolve('');
          }, 5000);

          tempWs.on('sync', (isSynced: boolean) => {
            if (isSynced) {
              clearTimeout(timeout);
              const text = ytext.toString();
              tempWs.disconnect();
              tempWs.destroy();
              tempYDoc.destroy();
              resolve(text);
            }
          });
        });

        // 3. Create the markdown file locally
        const fullFilePath = `${docTitle}.md`;
        const initialText = injectCosyncId(fileContent, docId);
        
        this.isApplyingRemoteUpdate = true;
        this.programmedModifications.add(fullFilePath);
        try {
          await this.app.vault.create(fullFilePath, initialText);
          const newHash = getContentHash(initialText);
          this.settings.syncHashes[docId] = newHash;
          if (!this.settings.fileMappings) {
            this.settings.fileMappings = {};
          }
          this.settings.fileMappings[fullFilePath] = docId;
          await this.saveSettings();

          console.log(`CoSync: Successfully created local file "${fullFilePath}"`);
          new Notice(`CoSync: Created new local note: "${docTitle}"`);
        } catch (err) {
          this.programmedModifications.delete(fullFilePath);
          console.error(`CoSync: Failed to create file "${fullFilePath}":`, err);
        } finally {
          this.isApplyingRemoteUpdate = false;
        }
      }
    } catch (err) {
      console.warn('CoSync: Error syncing new documents from server:', err);
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

    containerEl.createEl('h2', { text: 'CoSync Collaborative Settings' });

    // 1. Paste Connection Code
    new Setting(containerEl)
      .setName('Obsidian Connection Code')
      .setDesc('Paste the Connection Code from the CoSync web app here to configure the server, token, and workspace in one click.')
      .addTextArea(text => text
        .setPlaceholder('Paste your connection code here...')
        .setValue(this.plugin.settings.connectionCode)
        .onChange(async (value) => {
          this.plugin.settings.connectionCode = value.trim();
          if (value.trim()) {
            try {
              const config = JSON.parse(atob(value.trim()));
              this.plugin.settings.serverUrl = config.serverUrl;
              this.plugin.settings.token = config.token;
              this.plugin.settings.workspaceId = config.workspaceId;
              
              new Notice('CoSync: Connection Code parsed successfully!');
              await this.plugin.saveSettings();
              this.display(); // Re-render to show updated fields
              await this.plugin.reconnect();
            } catch (err) {
              new Notice('CoSync: Invalid connection code.');
            }
          } else {
            await this.plugin.saveSettings();
            await this.plugin.reconnect();
          }
        }));

    containerEl.createEl('h3', { text: 'Manual Connection Configurations' });

    new Setting(containerEl)
      .setName('CoSync Server Address')
      .setDesc('Enter the URL of the collaborative server (e.g., http://localhost:4000)')
      .addText(text => text
        .setPlaceholder('http://localhost:4000')
        .setValue(this.plugin.settings.serverUrl)
        .onChange(async (value) => {
          this.plugin.settings.serverUrl = value;
          await this.plugin.saveSettings();
          await this.plugin.reconnect();
        }));

    new Setting(containerEl)
      .setName('Authentication JWT Token')
      .setDesc('Enter the JWT token provided by the web interface')
      .addText(text => text
        .setPlaceholder('Paste your JWT token here')
        .setValue(this.plugin.settings.token)
        .onChange(async (value) => {
          this.plugin.settings.token = value;
          await this.plugin.saveSettings();
          await this.plugin.reconnect();
        }));

    new Setting(containerEl)
      .setName('Workspace ID')
      .setDesc('Specify the workspace identifier to synchronize within')
      .addText(text => text
        .setPlaceholder('ws-default')
        .setValue(this.plugin.settings.workspaceId)
        .onChange(async (value) => {
          this.plugin.settings.workspaceId = value;
          await this.plugin.saveSettings();
          await this.plugin.reconnect();
        }));

    containerEl.createEl('h3', { text: 'Vault Synchronization' });

    new Setting(containerEl)
      .setName('Sync Local Vault to Web')
      .setDesc('Upload and sync all markdown files in your vault to the connected workspace on the server.')
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

function injectCosyncId(content: string, docId: string): string {
  const cleanContent = content.replace(/^\uFEFF/, '');
  
  // Match frontmatter blocks containing "cosyncId:"
  const frontmatterRegex = /^---\r?\n([\s\S]*?cosyncId:[\s\S]*?)\r?\n---(?:\r?\n|$)/;
  
  let body = cleanContent;
  let otherFrontmatterLines: string[] = [];
  let hasFrontmatter = false;
  
  const match = cleanContent.match(frontmatterRegex);
  if (match) {
    hasFrontmatter = true;
    const innerContent = match[1];
    const lines = innerContent.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('cosyncId:')) {
        otherFrontmatterLines.push(line);
      }
    }
    body = cleanContent.replace(frontmatterRegex, '');
  }
  
  // Also strip any remaining loose cosyncId lines
  body = body.replace(/cosyncId:\s*[^\r\n]+/g, '');
  body = body.trim();
  
  // If we had other frontmatter lines, reconstruct the frontmatter block
  if (otherFrontmatterLines.length > 0) {
    const uniqueLines = Array.from(new Set(otherFrontmatterLines));
    return `---\n${uniqueLines.join('\n')}\n---\n\n${body}`;
  }
  
  // If there was no other frontmatter but we did match frontmatter, return just body (stripped)
  return body;
}

function getContentHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
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

export = CoSyncPlugin;
