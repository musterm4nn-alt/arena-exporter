# GitHub backups

Open the extension popup, then **Open archive library → GitHub backup**.

1. Create a private repository for your conversations, separate from the extension's source code.
2. Create a [fine-grained GitHub token](https://github.com/settings/personal-access-tokens/new). Select only that archive repository and grant **Contents: read and write**. Choose an expiration you can renew when needed.
3. Enter `owner/repository`, leave Branch blank to use its default branch, and keep Folder as `arena-archive`.
4. Paste the token into the extension's settings and click **Connect and enable backups**. Accept GitHub access and, on Firefox, the optional backup data permissions.
5. To include older files, select your existing `Downloads/arena-archive` directory under **Back up an existing archive folder**. Click **Back up now** to drain the queue immediately.

The token stays in this browser profile's extension storage. It is never included in exported conversations or queued files. Chrome restricts this storage to trusted extension contexts. Settings never send a saved token back to the popup. Signing in to GitHub in a browser or connecting GitHub to Codex does not connect an installed extension automatically.

## What happens automatically

After a successful local archive write, the extension saves a pending snapshot of that conversation, including JSON, Markdown and available attachment bytes. This also covers manual archive writes and history backfill. Identical files are not uploaded again. The remote `_index.json` is merged with other conversations already in the repository.

The browser checks pending backups once a minute and uploads up to ten conversations per batch. Its timing may be delayed while the device sleeps. Keep the browser running with the extension loaded for uploads. The IndexedDB queue survives background-worker restarts; network errors retry with backoff. Popup and Settings show queued work, the last successful backup and errors. **Back up now** processes successive batches while Settings remains open.

Updates arriving during an upload remain queued until their own snapshot is backed up. GitHub commits advance the selected branch without force-pushing. Concurrent changes are merged onto the newest head, unrelated files are preserved, and local deletions do not delete remote backup files. This is a one-way backup, not a GitHub-to-browser synchronization service.

**Pause** stops uploads and queuing new archive writes. Existing pending snapshots remain stored. **Disconnect** also removes the token. Import the archive again to include files written while paused. Changing repository, branch or folder does not redirect old queued snapshots: reconnect their original destination to upload them.

## Existing archives and limits

The folder picker imports conversation folders that contain `conversation.json`, preserving their original bytes. It does not watch that folder afterwards; automatic backups track writes made by this extension. The browser cannot silently read pre-existing files elsewhere on your disk.

Individual automatic-backup files are limited to 32 MiB. Folder import is limited to 32 MiB per conversation to stay within browser messaging limits. An oversized file or a full local queue is reported rather than silently dropped. GitHub permission failures, protected branches, public repositories and truncated repository trees stop an upload and leave it queued for retry. Local archiving continues even if GitHub is unavailable.

## Open the current conversation's folder

With an Arena conversation selected, click **Open folder** in the popup. If needed, the conversation is archived first. For Downloads archives, this opens the OS file manager at that conversation's folder. A small `_open-folder.txt` marker lets the browser reveal the folder even though normal archive download-history records have been erased.

The button refuses a different or non-Arena selected tab. For archives written by an external Arena Archive native host, it displays the actual native folder path; that host currently has no folder-opening operation.

## Restore

Clone your private repository, or use GitHub's **Code → Download ZIP**, then use the `arena-archive` subfolder as your restored archive. Previous snapshots remain available in Git history. GitHub backups do not include the extension's token or capture settings.

API references: [GitHub Git database](https://docs.github.com/en/rest/git), [browser alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms), [Firefox data permissions](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/).
