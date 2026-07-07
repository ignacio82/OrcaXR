# Privacy Policy for OrcaXR

**Effective Date:** April 28, 2026

This Privacy Policy applies to the OrcaXR Android application ("the App"). 

## 1. Data Collection and Usage

OrcaXR is designed to operate locally on your device and your local area network (LAN). **We do not collect, store, or transmit your personal data, 3D models, or printing history to any external servers.**

The App requires specific Android permissions to function, which are used strictly locally:

*   **Storage Access (`READ_EXTERNAL_STORAGE`, `MANAGE_EXTERNAL_STORAGE`):** Used exclusively to allow you to select and load 3D models (STL, 3MF, etc.) from your device's file system into the slicer.
*   **Network Access (`INTERNET`, `ACCESS_NETWORK_STATE`):** Used exclusively to communicate with your 3D printer's local web interface (e.g., Moonraker/Klipper) over your local network to upload G-code and monitor print status.

## 2. Telemetry and Analytics

The App does **not** integrate any third-party analytics, crash reporting (like Firebase Crashlytics), or telemetry frameworks. Everything you do in the App stays on your device.

## 3. Third-Party Services

While the App does not send data to us, it does interact directly with your 3D printer via its API (e.g., Moonraker). Please refer to the privacy and security documentation of your printer's firmware for how it handles data locally.

## 4. Changes to This Policy

If we add optional cloud features or opt-in crash reporting in the future, this Privacy Policy will be updated to reflect those changes, and you will be prompted to review them.

## 5. Contact Us

If you have any questions or concerns about this Privacy Policy or how your data is handled, please open an issue on our GitHub repository.