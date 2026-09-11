# YouTube Playback Position Auto Save v1.9.2

[日本語](README.md) | English

A Chrome extension that automatically saves YouTube playback positions in your browser and resumes videos where you left off when you open them again.

You can save playback positions even if YouTube watch history is turned off. Saved data stays in `chrome.storage.local` and is not sent to external servers.

## Features

- Automatically save YouTube playback positions every 5, 10, or 30 seconds (default: 5 seconds).
- Restore the saved position when you revisit a video.
- Pause before seeking to the saved position, then optionally resume playback after `seeked` or a maximum wait of 3 seconds.
- Avoid saving ad playback positions or durations, and retry restoring the main video after ads finish.
- Show a toast notification with the restored position (can be turned off).
- Turn automatic playback after restoration on or off. When off, the video stays paused at the saved position.
- Automatically delete saved data for completed videos (can be turned off). When off, save the ending position if it meets the minimum save time.
- Save during YouTube page navigation, browser back/forward navigation, when the tab becomes hidden, and when leaving the page.
- Exclude ongoing live streams from saving and restoration; treat archived streams as regular videos.
- Skip saving positions below a selected minimum of 10 seconds, 30 seconds, or 1 minute.
- Automatically delete old saved data after 30, 90, or 180 days.
- Export and import saved data as JSON files.
- Use the popup to browse, search, and delete saved videos, and enable or disable the extension.
- Delete all saved video data, export, or import from the settings screen.
- Switch to an existing tab for the same video when opening it from the popup, or choose to always open a new tab.
- Display the interface in Japanese or English.

## How it works

1. When you open a YouTube video page, `content.js` detects the video ID and video element.
2. If a saved position exists, the extension checks the video duration before restoring it. Restoration is deferred while an ad is playing.
3. To restore a position, the extension pauses the video and seeks to the saved position. Playback then resumes if the corresponding setting is enabled.
4. Periodic saves and event-triggered saves keep the playback position up to date.
5. A video is considered completed when it ends or reaches the final 3 seconds. If automatic deletion is enabled, its saved data is deleted. Otherwise, its ending position is saved if it meets the minimum save time.

## When positions are saved

- Periodically during playback: every 5 seconds by default, with 10- and 30-second options.
- When playback is paused.
- When navigating to another video within YouTube.
- When using the browser's back or forward buttons.
- When the tab becomes hidden.
- When closing or leaving the page.

Saving is suppressed during restoration and after completion to avoid overwriting the saved position incorrectly. If you seek back from the ending position after completing a video, saving can resume.

Saving is also suppressed during ads so that an ad's playback position or duration is not stored as data for the main video.

## When positions are not restored

To avoid restoring an incorrect position, restoration is skipped when:

- The page is not a YouTube video page.
- The extension is disabled in the popup.
- The video duration is unavailable or invalid.
- The current video duration differs from the saved duration by more than 5 seconds.
- The video is an ongoing live stream.
- The saved data is corrupt or lacks values required for restoration.

Skipping restoration because the duration has changed does not prevent new positions from being saved when the normal saving conditions are met.

Ongoing live streams are detected using the visibility of the player's live badge. Once a stream has ended and the badge is hidden, the archived video is saved and restored like a regular video.

During ads, the main video's saved position is not restored immediately. The extension retries restoration after the ad finishes.

## Popup controls

Click the extension icon in the toolbar to see your saved videos.

- View the saved video count and approximate storage size.
- Browse videos in order of most recently saved first.
- Search by title or video ID.
- Click a title to open the video on YouTube.
- Switch to an existing YouTube tab for the same video, if available.
- Delete saved data for individual videos.
- Enable or disable the extension.
- Customize behavior from the settings screen, as described below.
- Delete all saved video data, export, or import from the settings screen.

## Settings

Open settings using the gear icon in the upper-right corner of the popup.

**Saving and restoration**

| Setting | Default | Description |
| --- | --- | --- |
| Show notification on restore | On | Show a toast when the saved position is restored. |
| Auto-play after restore | On | When off, leave the video paused at the saved position. |
| Skip saving short watches | No limit | Do not save playback positions below the selected time: 10 seconds, 30 seconds, or 1 minute. This also applies when a video completes. |
| Auto-delete watched videos | On | When off, keep saved data after completion and save the ending position if it meets the minimum save time. |

**List and data**

| Setting | Default | Description |
| --- | --- | --- |
| Save interval | 5 seconds | Interval between position saves; 10 and 30 seconds are also available. |
| Auto-delete old saved data | Never | Clean up old data when the popup opens; choose 30, 90, or 180 days. |
| Open videos | Prefer existing tab | Choose whether to reuse a tab for the same video or always open a new tab. |

**Data management**

| Action | Description |
| --- | --- |
| Export | Write saved video data and settings to a JSON file. |
| Import | Read saved video data and settings from a JSON file. |
| Delete all | Delete all saved video data. |

## Installation

1. Download this folder.
2. Open `chrome://extensions/` in Chrome.
3. Turn on **Developer mode** in the upper-right corner.
4. Click **Load unpacked**.
5. Select this folder.

## Stored data

The extension uses `chrome.storage.local`. Each video's storage key has the form `yt_position_<videoId>`.

- Video ID
- Playback position
- Video duration
- Save timestamp
- Page title

Settings are stored under `yt_position_settings`.

## Permissions

The following permissions are declared in `manifest.json`:

- `storage`: Save playback positions and settings in the browser.
- `tabs`: Find and switch to an existing YouTube tab for the same video when opening it from the popup.
- `scripting`: Reinject `content.js` into existing YouTube tabs after an extension update or reload.
- `https://www.youtube.com/*`: Run `content.js` on YouTube pages and allow reinjection into existing tabs.

On normal page loads, scripts are injected automatically through `content_scripts` in `manifest.json`. For YouTube tabs that are already open, `background.js` checks whether the content script is responding and reinjects it if needed, only on extension installation, update, or browser startup. When reinjected, `content.js` cleans up old event listeners and timers to prevent duplicate instances.

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

- The extension works on YouTube video pages (`https://www.youtube.com/watch?v=...`).
- Ad playback positions are not saved; restoration of the main video is retried after ads finish.
- Playback positions are neither saved nor restored for ongoing live streams, including DVR playback.
- Browser autoplay restrictions may prevent playback from resuming automatically after restoration. If this happens, start playback manually.
- If the video duration changes by more than 5 seconds, restoration is skipped to avoid restoring an incorrect position.

## Files

```text
Youtube再生位置自動保存/
├── manifest.json        # Extension configuration
├── shared.js            # Shared validation for settings and video data
├── background.js        # Service worker for reinjection on installation/startup
├── content.js           # Playback position saving and restoration
├── popup.html           # Popup interface
├── popup.js             # Popup list, search, deletion, settings, and data management
├── popup.css            # Popup styles
├── tests/               # Unit tests using node:test
├── package.json         # npm test / npm run check
├── _locales/
│   ├── ja/messages.json # Japanese messages
│   └── en/messages.json # English messages
├── CHANGELOG.md         # Change history
├── LICENSE             # License
├── README.md           # Japanese README
└── README.en.md        # English README (this file)
```

## License

MIT License

## Version

Current version: **1.9.2**

See [CHANGELOG.md](CHANGELOG.md) for the detailed change history.

Repository: [Rakua-Laqua/YouTube-playback-position-auto-save](https://github.com/Rakua-Laqua/YouTube-playback-position-auto-save)
