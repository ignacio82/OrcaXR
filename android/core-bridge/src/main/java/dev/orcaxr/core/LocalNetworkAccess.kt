package dev.orcaxr.core

import java.io.IOException
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import okhttp3.Dns
import okhttp3.Interceptor

/** Whether the app may use the local network right now (Android's
 * `ACCESS_LOCAL_NETWORK`, which an operator can grant, deny or revoke at any
 * time). Asked again for every exchange, never remembered. */
fun interface LocalNetworkPermission {
    fun granted(): Boolean
}

/** An exchange refused because the app may not use the local network: the
 * platform would let it hang until a timeout, indistinguishable from a printer
 * that is switched off. */
class LocalNetworkDeniedException(host: String) :
    IOException("OrcaXR may not use the local network, so it cannot reach $host. Allow nearby devices for OrcaXR in the system settings.")

/**
 * The local-network permission, applied before a connection is attempted.
 *
 * Android 17 blocks an app targeting it from the local network until the
 * operator grants `ACCESS_LOCAL_NETWORK`; a blocked TCP connection is not
 * refused but left to time out. So every exchange is judged first: a name
 * resolved by multicast DNS (`.local`) or an address on the local network
 * (private, link-local or unique-local, IPv4-mapped included) needs the
 * permission, and without it the exchange fails at once with
 * [LocalNetworkDeniedException]. Loopback and the public internet never need
 * it. The permission is asked for each exchange, so a grant, a denial or a
 * revocation in the system settings takes effect on the next one.
 */
object LocalNetworkAccess {
    /** Whether reaching [address] needs the local-network permission. */
    fun requiresPermission(address: InetAddress): Boolean {
        if (address.isLoopbackAddress) return false
        if (address.isSiteLocalAddress || address.isLinkLocalAddress || address.isMulticastAddress) return true
        val bytes = address.address
        return when (address) {
            is Inet4Address -> false
            is Inet6Address ->
                (bytes[0].toInt() and 0xfe) == 0xfc ||
                    (mapped(bytes) && requiresPermission(InetAddress.getByAddress(bytes.copyOfRange(12, 16))))
            else -> false
        }
    }

    private fun mapped(bytes: ByteArray): Boolean =
        (0 until 10).all { bytes[it].toInt() == 0 } && bytes[10].toInt() == -1 && bytes[11].toInt() == -1

    /** Whether [host] is resolved by multicast DNS, which itself needs the permission. */
    fun multicastName(host: String): Boolean = host.trimEnd('.').lowercase().let { it == "local" || it.endsWith(".local") }

    /**
     * An OkHttp application interceptor refusing, before any connection, an
     * exchange whose host needs the permission while it is not granted. An
     * IP literal is judged as itself, a `.local` name before it is resolved,
     * and any other name by what [dns] resolves it to.
     */
    fun gate(permission: LocalNetworkPermission, dns: Dns): Interceptor = Interceptor { chain ->
        val host = chain.request().url.host
        if (!permission.granted() && needsPermission(host, dns)) throw LocalNetworkDeniedException(host)
        chain.proceed(chain.request())
    }

    private fun needsPermission(host: String, dns: Dns): Boolean {
        if (multicastName(host)) return true
        val addresses = literal(host)?.let(::listOf) ?: try {
            dns.lookup(host)
        } catch (_: IOException) {
            // Unresolvable: the exchange itself will say so.
            return false
        }
        return addresses.any(::requiresPermission)
    }

    /** An IP literal as OkHttp spells it (IPv6 without brackets), or null for a name. */
    private fun literal(host: String): InetAddress? {
        val ipv4 = Regex("""\d{1,3}(\.\d{1,3}){3}""")
        if (!host.contains(':') && !ipv4.matches(host)) return null
        return try {
            InetAddress.getByName(host)
        } catch (_: IOException) {
            null
        }
    }
}
