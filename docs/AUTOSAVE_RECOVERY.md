# Workspace autosave and recovery

Draw automatically saves edits in this browser's IndexedDB database. Saving is local to the browser profile and site address: `localhost` and `127.0.0.1`, or different ports, have separate storage. Keep using the same address to return to your workspaces.

The save indicator shows when an edit is saving and when it is saved on this device. The Save icon downloads a portable `.draw` file containing editable elements and embedded assets. It is a backup and transfer format, separate from local autosave. PNG and JPEG exports are flattened images.

## If Draw pauses autosave

Draw preserves stored content it cannot safely read instead of replacing it with an empty document. A recovery warning means new edits are not being autosaved in the affected board. Download a `.draw` backup of any new edits before closing the tab. Do not clear browser/site data to dismiss the warning.

Draw upgrades valid older documents, including documents that predate revision counters. If the preserved data is genuinely malformed, the Workspace recovery panel provides:

- **Download recovery data**: downloads the original stored payload as JSON for diagnosis or repair. This can contain your drawing and images; keep it private.
- **Enable autosave in new workspace**: saves the currently visible edits into a new workspace and reloads it. The original recovery data remains stored and can still be downloaded using the recovery-download icon in the toolbar.

If creation fails, Draw reports the error and keeps the current edits visible. A portable `.draw` download remains the way to preserve those edits while storage is unavailable.

## Storage limits

Browser storage is not cross-device sync. Clearing site data, deleting a browser profile, or using another origin/profile can remove or hide your workspaces. Keep portable `.draw` backups for work you need to retain independently of this browser.
