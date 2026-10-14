package dev.orcaxr.core

/**
 * Android core bridge for the calibration subsystem: definitions, compilation,
 * parameter forms, instructions, automation, application to presets, and
 * the tamper-evident history ledger.
 */
object ProjectCalibration {
    fun definitions(): String = NativeProject.calibrationDefinitions()

    fun compile(requestJson: String, jobId: String): String =
        NativeProject.calibrationCompile(requestJson, jobId)

    fun verify(planJson: String): String =
        NativeProject.calibrationVerify(planJson)

    fun form(requestJson: String): String =
        NativeProject.calibrationForm(requestJson)

    fun instructions(planJson: String): String =
        NativeProject.calibrationInstructions(planJson)

    fun automation(workflowId: String, objectsJson: String): String =
        NativeProject.calibrationAutomation(workflowId, objectsJson)

    fun application(recordJson: String, conditionsJson: String): String =
        NativeProject.calibrationApplication(recordJson, conditionsJson)

    fun lineProgram(planJson: String, optionsJson: String): String =
        NativeProject.calibrationLineProgram(planJson, optionsJson)

    fun flowMatching(patchesJson: String, effectsJson: String): String =
        NativeProject.calibrationFlowMatching(patchesJson, effectsJson)

    fun historyRecord(methodJson: String, conditionsJson: String, entryJson: String): String =
        NativeProject.calibrationHistoryRecord(methodJson, conditionsJson, entryJson)

    fun historyAssess(recordJson: String, conditionsJson: String): String =
        NativeProject.calibrationHistoryAssess(recordJson, conditionsJson)

    fun historyCompare(leftJson: String, rightJson: String): String =
        NativeProject.calibrationHistoryCompare(leftJson, rightJson)

    fun historyExport(recordsJson: String, exportedAt: String): String =
        NativeProject.calibrationHistoryExport(recordsJson, exportedAt)

    fun historyImport(text: String): String =
        NativeProject.calibrationHistoryImport(text)

    fun historyRerun(recordJson: String, prerequisitesJson: String): String =
        NativeProject.calibrationHistoryRerun(recordJson, prerequisitesJson)
}
