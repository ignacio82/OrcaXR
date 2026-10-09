package dev.orcaxr.core

import java.io.IOException
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.Proxy
import okhttp3.Interceptor

/** A plain-HTTP exchange the app's policy refused: its destination is not on the local network. */
class CleartextRefusedException(host: String) :
    IOException("Plain HTTP is allowed only to a printer or slicer on the local network; $host is not one.")

/**
 * The app's own rule for plain-HTTP (and plain-WebSocket) traffic.
 *
 * Printers and the operator's own slicer are plain-HTTP services at addresses
 * the operator types, which no network-security domain rule can name, so the
 * platform permits cleartext and this policy admits it only to a local
 * address — judged by the address the connection actually reached, after name
 * resolution, never by the name. TLS stays system-validated, and a redirect is
 * never followed, so a credential cannot be carried to another host.
 */
object LanTransportPolicy {
    /**
     * Whether [address] is on the operator's own network: loopback,
     * link-local, private (RFC 1918), IPv6 unique-local (fc00::/7), or the
     * shared address space (RFC 6598, 100.64.0.0/10) that VPN overlays such as
     * Tailscale use and the internet does not route.
     */
    fun isLocal(address: InetAddress): Boolean {
        if (address.isLoopbackAddress || address.isLinkLocalAddress || address.isSiteLocalAddress) return true
        val bytes = address.address
        return when (address) {
            is Inet4Address -> local4(bytes)
            is Inet6Address -> {
                val first = bytes[0].toInt() and 0xff
                // Unique local (fc00::/7), or an IPv4-mapped address judged as itself.
                (first and 0xfe) == 0xfc || (mapped(bytes) && local4(bytes.copyOfRange(12, 16)))
            }
            else -> false
        }
    }

    private fun local4(bytes: ByteArray): Boolean {
        val a = bytes[0].toInt() and 0xff
        val b = bytes[1].toInt() and 0xff
        return a == 10 || a == 127 || (a == 172 && b in 16..31) || (a == 192 && b == 168) ||
            (a == 169 && b == 254) || (a == 100 && b in 64..127)
    }

    private fun mapped(bytes: ByteArray): Boolean =
        (0 until 10).all { bytes[it].toInt() == 0 } && bytes[10].toInt() == -1 && bytes[11].toInt() == -1

    /**
     * An OkHttp network interceptor refusing a cleartext exchange to anything
     * but a local address, or through a proxy, whose destination it cannot see.
     */
    val cleartextGuard: Interceptor = Interceptor { chain ->
        val request = chain.request()
        if (!request.isHttps) {
            val route = chain.connection()?.route()
            val address = route?.socketAddress?.address
            if (route == null || route.proxy.type() != Proxy.Type.DIRECT || address == null || !isLocal(address)) {
                throw CleartextRefusedException(request.url.host)
            }
        }
        chain.proceed(request)
    }
}
