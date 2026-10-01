# Project recovery

OrcaXR captures recovery snapshots in this browser after five seconds without an
edit, or after thirty seconds of continuous editing. Recovery does not mark a
project as saved. Use **Save Project** to download a portable project file; the
status confirms browser handoff, not completion of the disk write.

Open the **Project** view on the desktop or in XR to see stored snapshots with
project names and timestamps. **Recover** validates the archive and offers any
import notices before replacing the current project. Recovered content remains
unsaved. **Download recovery file** exports the stored archive, and **Discard
recovery** deletes only the selected snapshot. Older snapshots remain available
if the newest archive is damaged. An archive from an unsupported version is
preserved for explicit download or discard.

Each editing tab has a separate session. Up to three snapshots are retained per
project/session. One tab never prunes another tab's snapshots. The default total
budget is 512 MiB, adjustable in the Project view up to 1024 MiB and available
browser quota. A failed storage transaction retains previous snapshots. Storage
or worker failures appear in the Project recovery status and do not stop editing
or explicit manual export. Browser data clearing can remove these snapshots;
recovery does not replace saving files.

New, Open/Replace, application updates and app-owned navigation offer **Save and
continue**, **Discard and continue**, or **Cancel** when work is dirty. Discard
removes supported snapshots owned by the current project/session. A decision
cannot discard newer edits made while the dialog was open. Browser toolbar
reload and tab close use the browser's own unsaved-work prompt; asynchronous
capture during unload is not guaranteed. Switching away from the page requests a
best-effort capture.

**Help → Check for Update** checks for a waiting application version and routes
its activation/reload through the same decision. A new edit during activation
requires another decision before reload. HTTP LAN editing/recovery works without
secure-context-only crypto APIs; service-worker updates are unavailable on those
origins. Browser storage policies and headset interaction still require
qualification on the operator's actual browser/device.
