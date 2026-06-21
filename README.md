# 🔌 Obsidian CoSync — Real-Time Collaborative Sync Plugin

**Obsidian CoSync** is a production-grade, local-first real-time collaborative synchronization plugin for Obsidian. Powered by **Yjs (CRDTs)** for conflict-free multi-user editing and **WebSockets** for lightweight real-time communication, Obsidian CoSync connects your local markdown files to your private CoSync Web workspace seamlessly.

---

## 🌟 Key Features

*   ✍️ **Real-Time Collaboration:** Co-edit markdown notes with other users or your own devices simultaneously without sync conflicts.
*   👥 **User Presence & Carets:** View active collaborator cursors and name badges with custom colors directly inside the editor (Notion/Google Docs style).
*   🔒 **Secure Local-First Sync:** Keeps your notes stored locally on your device while synchronizing incremental updates in the background.
*   🌗 **Adaptive Theme Compatibility:** Works seamlessly with Obsidian's dark and light modes.

---

## 🚀 Installation Guide

Choose one of the following methods to install **Obsidian CoSync** on your devices.

### Method 1: Via BRAT (Recommended for Beta & Mobile - iOS / Android)

Since mobile platforms do not easily expose file directories, using **BRAT** (Beta Reviewer's Auto-update Tool) is the easiest way to install the plugin and keep it automatically updated:

1. Open Obsidian on your device.
2. Go to **Settings** -> **Community Plugins** and click **Browse**.
3. Search for **BRAT** (by TFTFeature) and click **Install**, then **Enable**.
4. Open the **BRAT** settings from the sidebar.
5. Click **Add Beta Plugin**.
6. Enter the GitHub repository URL of this plugin:
   `https://github.com/your-username/obsidian-cosync`
7. Click **Add Plugin**. BRAT will download, install, and enable **Obsidian CoSync** automatically!

---

### Method 2: Manual Installation (Desktop - Windows / macOS / Linux)

1. Navigate to the **Releases** page of this repository and download the latest release files:
   - `main.js`
   - `manifest.json`
   - `styles.css`
2. Open your Obsidian vault folder in your file explorer.
3. Locate or create the community plugins directory:
   `<your-vault>/.obsidian/plugins/`
4. Create a new directory inside it named:
   `obsidian-cosync`
5. Copy the three downloaded files (`main.js`, `manifest.json`, and `styles.css`) into that new folder.
6. Open Obsidian, go to **Settings** -> **Community Plugins**, and click the toggle next to **Obsidian CoSync** to enable it.

---

### Method 3: Obsidian Community Plugins Store (Official - Coming Soon)

Once approved in the official Obsidian store:
1. Go to **Settings** -> **Community Plugins** and click **Browse**.
2. Search for **Obsidian CoSync**.
3. Click **Install**, then **Enable**.

---

## ⚙️ Configuration & Connection

1. Go to Obsidian settings and select **Obsidian CoSync** from the sidebar.
2. In the **Server URL** input field, enter your deployed CoSync API server address:
   - For local development: `http://localhost:4000`
   - For private deployments: `https://cosync-api.yourdomain.com`
3. Enter your account **Username** and **Password** (or paste an invitation join link).
4. Click **Connect**. Once successfully connected, the status indicator in the bottom status bar will turn green, and your vault notes will begin synchronizing in real-time.

---

## 🛠️ Development & Building from Source

If you want to build or modify the plugin locally:

1. Clone the repository and install all dependencies:
   ```bash
   npm install
   ```
2. Build the plugin for production:
   ```bash
   npm run build
   ```
   This compiles `main.ts` into a clean, standalone bundle `main.js` using `esbuild`.
3. Build and auto-copy to a local vault for development:
   ```bash
   npm run build:dev
   ```
   *(Note: You can customize the destination vault path inside `package.json` to point to your local test vault).*
