package dev.orcaxr.core

/** Watching the print (`orcaxr_printer::camera`), as the browser's
 * `PrinterCamera` answers it: a printer's cameras read from its listing
 * (each reported URL resolved against the endpoint: a path on Moonraker, a
 * URL on another port of the same machine fetched without the printer's
 * credential, or refused), the route a frame takes and what a failed fetch
 * reads as, the routes worth trying, the service's description, the poll
 * interval and a fresh frame URL. The host fetches and shows the frames, and
 * stops polling when the camera is hidden. */
object PrinterCamera {
    fun listPlan(): ProjectIntents.PrinterSend = ProjectIntents.decodePrinterSend(NativeProject.cameraListPlan())
    fun listFinish(request: ProjectIntents.CameraListFinish): ProjectIntents.CameraListResult =
        ProjectIntents.decodeCameraListResult(NativeProject.cameraListFinish(ProjectIntents.encodeCameraListFinish(request)))
    /** [reply] is Moonraker's `result`, as JSON. */
    fun listRead(request: ProjectIntents.CameraListRequest, reply: String): ProjectIntents.CameraListResult =
        ProjectIntents.decodeCameraListResult(NativeProject.cameraListRead(ProjectIntents.encodeCameraListRequest(request), reply))
    fun snapshotPlan(request: ProjectIntents.CameraSnapshotRequest): ProjectIntents.CameraSnapshotPlan =
        ProjectIntents.decodeCameraSnapshotPlan(NativeProject.cameraSnapshotPlan(ProjectIntents.encodeCameraSnapshotRequest(request)))
    fun snapshotFailure(request: ProjectIntents.CameraSnapshotFinish): ProjectIntents.CameraFailure =
        ProjectIntents.decodeCameraFailure(NativeProject.cameraSnapshotFailure(ProjectIntents.encodeCameraSnapshotFinish(request)))
    fun mechanisms(request: ProjectIntents.CameraMechanismsRequest): List<ProjectIntents.CameraMechanism> =
        ProjectIntents.decodeCameraMechanisms(NativeProject.cameraMechanisms(ProjectIntents.encodeCameraMechanismsRequest(request)))
    fun describe(request: ProjectIntents.CameraDescribeRequest): ProjectIntents.PrinterText =
        ProjectIntents.decodePrinterText(NativeProject.cameraDescribe(ProjectIntents.encodeCameraDescribeRequest(request)))
    fun pollIntervalMs(camera: ProjectIntents.PrinterCamera): Double =
        NativeProject.cameraPollInterval(ProjectIntents.encodePrinterCamera(camera))
    fun frameUrl(request: ProjectIntents.CameraFrameRequest): ProjectIntents.OptionalPrinterReplyText =
        ProjectIntents.decodeOptionalPrinterReplyText(NativeProject.cameraFrameUrl(ProjectIntents.encodeCameraFrameRequest(request)))
}
