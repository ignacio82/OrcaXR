package dev.orcaxr.core

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build

/** The app's local-network permission: Android 17 asks the operator for it;
 * earlier releases grant it with the network itself. */
object AndroidLocalNetwork {
    fun permission(context: Context): LocalNetworkPermission {
        val application = context.applicationContext
        return LocalNetworkPermission {
            Build.VERSION.SDK_INT < ANDROID_17 ||
                application.checkSelfPermission(Manifest.permission.ACCESS_LOCAL_NETWORK) == PackageManager.PERMISSION_GRANTED
        }
    }

    private const val ANDROID_17 = 37
}
