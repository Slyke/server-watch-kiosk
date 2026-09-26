# Kiosk display and screen sleep

The live board requests a **screen wake lock** by default while its page is visible. **Options → Keep screen awake** enables/disables it per browser, and the adjacent status reports whether it was acquired, released, unsupported or denied. Offline demo mode does not request it.

The page releases its lock when hidden, on teardown, or when the option is disabled. It requests a new lock when it becomes visible again. An OS/browser rejection or unsolicited release does not cause a busy retry loop; use **Retry screen wake lock** or return to the page to retry.

The [Screen Wake Lock API](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API) needs a supporting browser and a secure context (HTTPS, or a trustworthy local origin such as localhost). An ordinary HTTP LAN address may not expose it. Reverse proxies or embedding pages must not block the `screen-wake-lock` Permissions Policy.

A granted screen lock asks the platform to keep the screen from dimming or locking. It is advisory: low battery, power-saving settings, browser policy, or loss of visibility can release it. It does **not** synthesize user input, alter OS power settings, override a managed logout policy, or promise that the browser/application session will never be terminated. Configure the display machine's sleep, screensaver and logout settings for a dedicated unattended kiosk.

**Full screen** changes browser display mode only. The screen wake lock is separate and does not require full screen. Pausing status updates also does not turn the display off.

The theme override, compact layout, custom card orders and keep-awake preference are stored in the browser profile. Retain that profile across kiosk restarts. Clearing site storage restores server/default preferences.
