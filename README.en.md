# YouTube Playback Position Saver v1.10.4

[日本語](README.md) | English

A Chrome extension that automatically saves YouTube playback positions in your browser and resumes videos where you left off when you open them again.

You can save playback positions even if YouTube watch history is turned off. Playback positions and settings are saved in `chrome.storage.local`, and temporary state for post-restart tab restore correction is kept in `chrome.storage.session`. All data stays in your browser and is never sent to external servers.

## Features

### Playback Position Saving and Restoration
- Automatically save YouTube playback positions every 5, 10, or 30 seconds (default: 5 seconds).
- Save during YouTube page navigation, browser back/forward navigation, when the tab becomes hidden, and when leaving the page.
- Restore the saved position when you revisit a video (skipped when the URL specifies `?t=` or `?start=`, preserving YouTube's standard timestamp jump).
- Prefetch stored data on video detection, temporarily mute audio while waiting to seek (except during ads and live streams) to prevent brief audio playback from the start, pause before seeking, and optionally resume playback after `seeked` or a maximum wait of 3 seconds.
- Show a toast notification with the restored position (can be turned off).
- Turn automatic playback after restoration on or off. When off, the video stays paused at the saved position.
- After a Chrome restart, if a restored video tab (such as a playlist tab that advanced via autoplay) is switched back to another video during loading, navigate it back to the originally restored video ([background](docs/playlist-restore-investigation.md), Japanese).

### Scope Control and Cleanup
- Skip saving positions below a selected minimum of 10 seconds, 30 seconds, or 1 minute.
- Automatically delete saved data for completed videos (can be turned off). When off, save the ending position if it meets the minimum save time.
- Automatically delete old saved data after 30, 90, or 180 days (cleaned up when the popup opens and when the setting is changed).
- Avoid saving ad playback positions or durations, and retry restoring the main video after ads finish.
- Exclude ongoing live streams from saving and restoration; treat archived streams as regular videos.

### Popup and Data Management
- Use the popup to browse, search, and delete saved videos, and enable or disable the extension.
- Switch to an existing tab for the same video when opening it from the popup, or choose to always open a new tab.
- Delete all saved video data, or export and import saved data as JSON files from the settings screen.
- Display the interface in Japanese or English.

## How it works

1. **Video detection**: Injected early via `run_at: document_start` in `manifest.json`, `content.js` detects the video ID (`v` query parameter) and `<video>` element while prefetching stored data from `chrome.storage.local`.
2. **Saved position check**: Unless `?t=` or `?start=` is present in the URL, the extension temporarily mutes the video (when not in an ad or live stream) while checking the stored data and video duration. Restoration is deferred while an ad is playing.
3. **Position restoration**: When restorable, the extension pauses the video, seeks to the saved position, and restores the original mute state after `seeked` (or a 3-second timeout). Playback then resumes if the corresponding setting is enabled.
4. **Active playback saving**: Periodic saves and event-triggered saves keep the playback position up to date.
5. **Completion handling**: A video is considered completed on the `ended` event or when periodic/pause saving observes the playback within the final 3 seconds (snapshot saves on tab hide, navigation, or page unload do not apply the 3-second end threshold). If automatic deletion is enabled, its saved data is deleted; otherwise, its ending position is saved if it meets the minimum save time.

## When positions are saved

### Trigger events
- Periodically during playback: every 5 seconds by default, with 10- and 30-second options.
- When playback is paused.
- When navigating to another video within YouTube.
- When using the browser's back or forward buttons.
- When the tab becomes hidden.
- When closing or leaving the page.

### Suppression cases
- **Pending restoration, during restoration, and after completion**: Saving is suppressed before restoration finishes (including while loading storage or waiting for ads to end) and after video completion so the saved position is not overwritten incorrectly. If you seek back earlier than 3 seconds before the end after completing a video, saving resumes.
- **During ads**: Saving is suppressed during ads so that an ad's playback position or duration is not stored as data for the main video.
- **Live streams and below minimum save time**: Ongoing live streams and playback positions below the configured minimum save time are not saved.

## When positions are not restored

To avoid restoring an incorrect position or overriding explicit timestamps, restoration is skipped when:

- The page is not a YouTube video page with a `v` query parameter.
- The URL includes a valid start timestamp parameter (`?t=` or `?start=`).
- The extension is disabled in the popup, or loading settings fails.
- The video duration is unavailable or invalid.
- The current video duration differs from the saved duration by more than 5 seconds.
  - Skipping restoration because the duration has changed does not prevent new positions from being saved when the normal saving conditions are met.
- The video is an ongoing live stream.
  - Ongoing live streams are detected using the visibility of the player's live badge. Once a stream has ended and the badge is hidden, the archived video is saved and restored like a regular video.
  - If a video is found to be an ongoing live stream or has an invalid duration during post-metadata or post-ad validation, its existing saved data is also removed.
- The saved position is `0` seconds, or the saved data is corrupt or lacks required values.

### Restoration behavior during ads
During ads, the main video's saved position is not restored immediately. The extension retries restoration after the ad finishes, and skips restoration if waiting for ads exceeds the 120-second limit.

## Popup controls

Click the extension icon in the toolbar to see your saved videos.

### Browsing and Search
- View the saved video count and approximate storage size.
- Browse videos in order of most recently saved first.
- Search by title or video ID.

### Video Actions
- Click a video entry to open it on YouTube.
- Switch to an existing YouTube tab for the same video, if available (can be changed to always open a new tab).
- Delete saved data for individual videos.

### Settings and Data Management
- Enable or disable the extension.
- Customize behavior from the settings screen, as described below.
- Delete all saved video data, export, or import from the settings screen.

## Settings

Open settings using the gear icon in the upper-right corner of the popup.

### Save and Restore

| Setting | Default | Description |
| --- | --- | --- |
| Show restore notification | On | Show a toast when the saved position is restored. |
| Autoplay after restore | On | When off, leave the video paused at the saved position. |
| Ignore brief watches | No limit | Do not save playback positions below the selected time: 10 seconds, 30 seconds, or 1 minute. This also applies when a video completes. |
| Auto-delete fully watched videos | On | When off, keep saved data after completion and save the ending position if it meets the minimum save time. |

### List and Data

| Setting | Default | Description |
| --- | --- | --- |
| Save interval | 5 sec | Interval between position saves; 10 and 30 seconds are also available. |
| Auto-delete old saved data | Never | Clean up old data when the popup opens and when this setting changes; choose 30, 90, or 180 days. |
| Open video behavior | Prefer existing tab | Choose whether to reuse a tab for the same video or always open a new tab. |

### Data Management

| Action | Description |
| --- | --- |
| Export | Write saved video data and settings to a JSON file. |
| Import | Read saved video data and settings from a JSON file. |
| Delete All | Delete all saved video data. |

## Installation

1. Download this folder.
2. Open `chrome://extensions/` in Chrome.
3. Turn on **Developer mode** in the upper-right corner.
4. Click **Load unpacked**.
5. Select this folder.

## Stored data

### `chrome.storage.local` (persistent)

- **Playback Position Data (Key: `yt_position_<videoId>`)**:
  - Playback position (`position`)
  - Video duration (`duration`)
  - Save timestamp (`timestamp`)
  - Page title (`title`)
  - Note: the video ID is stored in the key name and reconstructed from the key when read.
- **Settings Data (Key: `yt_position_settings`)**:
  - Stores extension settings configured in the popup and settings view.

### `chrome.storage.session` (temporary session state)

- **Tab Restore Guard State (Key: `restoreGuardTabs`)**:
  - Tracks unloaded restored `/watch` tabs across service worker restarts. Discarded when the browser closes.

## Permissions

### Declared Permissions
The following permissions are declared in `manifest.json`:

- `storage`: Save playback positions and settings in `chrome.storage.local`, and keep temporary restore-guard state in `chrome.storage.session`.
- `tabs`: Find and switch to an existing YouTube tab from the popup, reinject `content.js` into open YouTube tabs, and monitor/redirect restored tabs after a restart.
- `scripting`: Reinject `content.js` into existing YouTube tabs after an extension update or reload.
- `webNavigation`: Detect when Chrome switches a restored video tab to a different URL after a restart, and navigate it back.
- `https://www.youtube.com/*`: Run `content.js` on YouTube pages and allow reinjection into existing tabs.

### Script Injection and Reinjection
On normal page loads, scripts are injected automatically through `content_scripts` (`run_at: document_start`) in `manifest.json`. For YouTube tabs that are already open, `background.js` checks whether the content script is responding and reinjects it if needed, only on extension installation, update, or browser startup. When reinjected, `content.js` cleans up old event listeners and timers, and orphaned instances from invalidated extension contexts self-terminate to prevent duplicates.

## Key constants

| Item | Value | Description |
| --- | --- | --- |
| Save interval | 5 / 10 / 30 seconds | Selected in settings and normalized in `shared.js`. |
| `VIDEO_CHECK_INTERVAL_MS` | 100 ms | Interval for detecting the `<video>` element. |
| `VIDEO_CHECK_TIMEOUT_MS` | 5000 ms | Timeout for detecting the `<video>` element. |
| `END_THRESHOLD_SEC` | 3 seconds | Threshold for treating a video as completed and deleting or retaining its saved data. |
| `DURATION_DIFF_THRESHOLD` | 5 seconds | Skip restoration if the duration difference exceeds this value. |
| `SEEKED_TIMEOUT_MS` | 3000 ms | Maximum wait for the `seeked` event. |
| `AD_RESTORE_RETRY_MS` | 1000 ms | Retry interval while waiting for ads to finish. |
| `AD_RESTORE_MAX_WAIT_MS` | 120000 ms | Maximum wait for ads to finish. |
| `NOTIFICATION_DURATION_MS` | 3000 ms | Toast display duration. |
| `NOTIFICATION_FADE_MS` | 500 ms | Toast fade-out duration. |
| `POPSTATE_INIT_DELAY_MS` | 300 ms | Initialization delay after `popstate`. |

## Limitations

- **Scope**: Works on pages under `https://www.youtube.com/*` that carry a `v` query parameter (normally `https://www.youtube.com/watch?v=...`).
- **Timestamped URLs**: URLs containing `?t=` or `?start=` skip automatic restoration in favor of YouTube's standard timestamp playback.
- **During ads**: Ad playback positions are not saved; restoration of the main video is retried after ads finish (up to 120 seconds).
- **Live streams**: Playback positions are neither saved nor restored for ongoing live streams, including DVR playback.
- **Autoplay restrictions**: Browser autoplay restrictions may prevent playback from resuming automatically after restoration. If this happens, start playback manually.
- **Duration changes**: If the video duration changes by more than 5 seconds, restoration is skipped to avoid restoring an incorrect position.

## Files

```text
YouTube-playback-position-auto-save/
├── manifest.json        # Extension configuration
├── shared.js            # Shared validation, session helpers, and URL parsing
├── background.js        # Service worker (reinjection on install/startup and restore-swap correction)
├── content.js           # Playback position saving and restoration
├── popup.html           # Popup interface
├── popup.js             # Popup list, search, deletion, settings, and data management
├── popup.css            # Popup styles
├── icons/               # Extension icons
├── tests/               # Unit tests using node:test
├── docs/                # Design and investigation notes
├── package.json         # npm test / npm run check
├── _locales/
│   ├── ja/messages.json # Japanese messages
│   └── en/messages.json # English messages
├── CHANGELOG.md         # Change history
├── LICENSE              # License
├── README.md            # Japanese README
└── README.en.md         # English README (this file)
```

## License

MIT License

## Version

Current version: **1.10.4**

See [CHANGELOG.md](CHANGELOG.md) for the detailed change history.

Repository: [Rakua-Laqua/YouTube-playback-position-auto-save](https://github.com/Rakua-Laqua/YouTube-playback-position-auto-save)
