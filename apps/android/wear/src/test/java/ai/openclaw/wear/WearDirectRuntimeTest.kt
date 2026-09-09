package ai.openclaw.wear

import ai.openclaw.app.gateway.GatewayEndpoint
import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.lang.management.ManagementFactory
import java.util.Base64
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class WearDirectRuntimeTest {
  @Test
  fun certificatePersistenceCannotFollowCompletedIntentRetirement() = verifyCertificateRetirement(concurrent = true)

  @Test
  fun certificateAcceptanceAfterRetirementCannotMutatePin() = verifyCertificateRetirement(concurrent = false)

  private fun verifyCertificateRetirement(concurrent: Boolean) =
    runBlocking {
      val context = RuntimeEnvironment.getApplication()
      val backing = context.getSharedPreferences("pin-retirement-${UUID.randomUUID()}", Context.MODE_PRIVATE)
      val endpoint = GatewayEndpoint.manual("gateway.example", 443, true)
      val pinKey = "gateway.tls.${endpoint.stableId}"
      val oldPin = "a".repeat(64)
      val acceptedPin = "b".repeat(64)
      val gateArmed = AtomicBoolean(false)
      val pinRead = CountDownLatch(1)
      val releasePin = CountDownLatch(1)
      val retired = CountDownLatch(1)
      val acceptanceThread = AtomicReference<Thread>()
      val pinMutated = AtomicBoolean(false)
      val mutatedAfterRetirement = AtomicBoolean(false)
      val prefs =
        object : SharedPreferences by backing {
          override fun getString(
            key: String?,
            defValue: String?,
          ): String? {
            if (key == pinKey && gateArmed.compareAndSet(true, false)) {
              acceptanceThread.set(Thread.currentThread())
              pinRead.countDown()
              check(releasePin.await(8, TimeUnit.SECONDS)) { "Pin persistence gate timed out" }
            }
            return backing.getString(key, defValue)
          }

          override fun edit(): SharedPreferences.Editor {
            val edit = backing.edit()
            return object : SharedPreferences.Editor by edit {
              override fun putString(
                key: String?,
                value: String?,
              ): SharedPreferences.Editor {
                if (key == pinKey && value == acceptedPin) {
                  pinMutated.set(true)
                  if (retired.count == 0L) mutatedAfterRetirement.set(true)
                }
                edit.putString(key, value)
                return this
              }
            }
          }
        }
      val store = WearGatewayStore(prefs)
      store.replace(WearGatewaySetup(endpoint, "watch-bootstrap"), "watch-device")
      assertTrue(store.putStringSynchronously(pinKey, oldPin))
      val job = SupervisorJob()
      val scope = CoroutineScope(job + Dispatchers.Default)
      val runtime = WearDirectRuntime(context, scope, store)
      val generation =
        runtime.javaClass.getDeclaredField("generation").run {
          isAccessible = true
          getLong(runtime)
        }
      val prompt = WearTrustPrompt(generation, acceptedPin, oldPin)

      // This stages the persistence owner's prompt, not a TLS handshake or certificate proof.
      @Suppress("UNCHECKED_CAST")
      val mutableState =
        runtime.javaClass.getDeclaredField("mutableState").run {
          isAccessible = true
          get(runtime) as MutableStateFlow<WearDirectState>
        }
      mutableState.value = mutableState.value.copy(trust = prompt)
      val monitor =
        runtime.javaClass.getDeclaredField("lock").run {
          isAccessible = true
          get(runtime)
        }
      var retiringThread: Thread? = null
      try {
        if (concurrent) {
          gateArmed.set(true)
          runtime.acceptCertificate(prompt)
          assertTrue("Acceptance did not reach the pin read", pinRead.await(8, TimeUnit.SECONDS))
          val retiring =
            thread(name = "wear-intent-retirement", isDaemon = true) {
              runtime.disconnect()
              retired.countDown()
            }
          retiringThread = retiring
          val threads = ManagementFactory.getThreadMXBean()
          withTimeout(8000) {
            while (retired.count != 0L) {
              val info = threads.getThreadInfo(retiring.threadId())
              if (info != null && info.threadState == Thread.State.BLOCKED &&
                info.lockInfo?.identityHashCode == System.identityHashCode(monitor) &&
                info.lockOwnerId == acceptanceThread.get().threadId()
              ) {
                break
              }
              yield()
            }
          }
          releasePin.countDown()
          assertTrue("Retirement did not finish", retired.await(8, TimeUnit.SECONDS))
        } else {
          runtime.disconnect()
          retired.countDown()
          runtime.acceptCertificate(prompt)
        }
        withTimeout(8000) { job.children.toList().joinAll() }
        assertEquals(concurrent, pinMutated.get())
        assertEquals(if (concurrent) acceptedPin else oldPin, backing.getString(pinKey, null))
        assertFalse("Certificate pin mutated after the intent retired", mutatedAfterRetirement.get())
      } finally {
        releasePin.countDown()
        retiringThread?.join(8000)
        withTimeout(8000) { job.cancelAndJoin() }
        assertFalse("Retirement thread leaked", retiringThread?.isAlive == true)
      }
    }

  @Test
  fun firstSetupFailureRemainsVisibleUntilExplicitCancellation() =
    runBlocking {
      val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
      val runtime = runtime(scope)
      try {
        assertTrue(runtime.isPhoneProxySelected())
        runtime.setup("not-a-setup-code")
        assertEquals(null, runtime.state.value.selected)
        assertTrue(runtime.state.value.connectionManagementRequired)
        assertTrue(runtime.state.value.error != null)
        assertFalse(runtime.isPhoneProxySelected())
        runtime.cancelSetup()
        withTimeout(8000) { runtime.state.first { !it.busy && !it.connectionManagementRequired } }
        assertTrue(runtime.isPhoneProxySelected())
      } finally {
        scope.cancel()
      }
    }

  @Test
  fun bootstrapConnectsWithoutPhoneAndLoadsCanonicalSessionApprovalUnion() =
    runBlocking {
      val gateway = Gateway()
      val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
      val runtime = runtime(scope)
      try {
        runtime.setVisible(true)
        runtime.setup(gateway.setupCode())
        val state = withTimeout(8000) { runtime.state.first { it.connected && it.approvalsReady } }
        assertEquals(setOf("exec", "plugin", "system-agent"), state.approvals.map { it.kind }.toSet())
        val node = withTimeout(8000) { gateway.connects.receive() }
        val operator = withTimeout(8000) { gateway.connects.receive() }
        assertEquals("node", node.text("role"))
        assertTrue((node["scopes"] as? JsonArray).isNullOrEmpty())
        assertEquals("operator", operator.text("role"))
        assertEquals(wearOperatorScopePolicy.requestedScopes, (operator["scopes"] as JsonArray).map { it.toString().trim('"') }.toSet())
        assertFalse(runtime.isPhoneProxySelected())
        assertEquals("agent:main:main", state.sessionKey)
      } finally {
        runtime.disconnect()
        runtime.setVisible(false)
        scope.cancel()
        gateway.server.shutdown()
      }
    }

  @Test
  fun lostChatAcknowledgementRequiresExplicitRetryWithTheSameAttemptKey() =
    runBlocking {
      val gateway = Gateway()
      gateway.answerSend = false
      val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
      val runtime = runtime(scope)
      try {
        runtime.setVisible(true)
        runtime.setup(gateway.setupCode())
        withTimeout(8000) { runtime.state.first { it.connected && it.approvalsReady } }
        runtime.send("A watch message", runtime.inputOwner())
        val sent = withTimeout(8000) { gateway.sends.receive() }
        assertEquals(false, sent.flag("deliver"))
        runtime.disconnect()
        withTimeout(8000) { runtime.state.first { !it.busy } }
        assertTrue(runtime.state.value.sendUnknown)
        gateway.answerSend = true
        runtime.reconnect()
        withTimeout(8000) { runtime.state.first { it.connected && it.approvalsReady } }
        assertTrue(gateway.sends.tryReceive().isFailure)
        runtime.retrySend()
        val retried = withTimeout(8000) { gateway.sends.receive() }
        assertEquals(sent.text("idempotencyKey"), retried.text("idempotencyKey"))
        withTimeout(8000) { runtime.state.first { !it.sending && it.pendingSend == null } }
        assertFalse(runtime.state.value.sendUnknown)
      } finally {
        runtime.disconnect()
        runtime.setVisible(false)
        scope.cancel()
        gateway.server.shutdown()
      }
    }

  private fun runtime(scope: CoroutineScope): WearDirectRuntime {
    val context = RuntimeEnvironment.getApplication()
    return WearDirectRuntime(context, scope, WearGatewayStore(context.getSharedPreferences("direct-${UUID.randomUUID()}", Context.MODE_PRIVATE)))
  }

  private class Gateway {
    val connects = Channel<JsonObject>(Channel.UNLIMITED)
    val sends = Channel<JsonObject>(Channel.UNLIMITED)

    @Volatile var answerSend = true
    val server =
      MockWebServer().apply {
        dispatcher =
          object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse =
              MockResponse().withWebSocketUpgrade(
                object : WebSocketListener() {
                  override fun onOpen(
                    webSocket: WebSocket,
                    response: Response,
                  ) {
                    webSocket.send("""{"type":"event","event":"connect.challenge","payload":{"nonce":"watch-runtime","ts":1700000000123}}""")
                  }

                  override fun onMessage(
                    webSocket: WebSocket,
                    text: String,
                  ) {
                    val frame = Json.parseToJsonElement(text).jsonObject
                    val params = frame["params"] as? JsonObject ?: buildJsonObject {}
                    val result =
                      when (frame.text("method")) {
                        "connect" -> {
                          connects.trySend(params)
                          val node = params.text("role") == "node"
                          Json.parseToJsonElement(
                            if (node) {
                              """{"auth":{"role":"node","deviceToken":"watch-node","scopes":[],"deviceTokens":[{"role":"operator","deviceToken":"watch-operator","scopes":["operator.read","operator.write","operator.approvals","operator.questions","operator.talk.secrets"]}]},"snapshot":{"sessionDefaults":{"mainSessionKey":"agent:main:main"}}}"""
                            } else {
                              """{"auth":{"role":"operator","deviceToken":"watch-operator","scopes":["operator.read","operator.write","operator.approvals"]},"snapshot":{"sessionDefaults":{"mainSessionKey":"agent:main:main"}}}"""
                            },
                          )
                        }

                        "sessions.list" -> {
                          Json.parseToJsonElement("""{"sessions":[{"key":"agent:main:main","displayName":"Main"}]}""")
                        }

                        "sessions.messages.subscribe" -> {
                          buildJsonObject {
                            put("subscribed", true)
                            put("key", "agent:main:main")
                            put(
                              "approvalReplay",
                              buildJsonObject {
                                put("sessionKey", "agent:main:main")
                                put("updatedAtMs", 1)
                                put("truncated", false)
                                put("approvals", JsonArray(listOf("exec", "plugin", "system-agent").map(::approval)))
                              },
                            )
                          }
                        }

                        "chat.history" -> {
                          Json.parseToJsonElement("""{"messages":[]}""")
                        }

                        "chat.send" -> {
                          sends.trySend(params)
                          if (!answerSend) return
                          Json.parseToJsonElement("""{"runId":"watch-run","status":"started"}""")
                        }

                        else -> {
                          buildJsonObject {}
                        }
                      }
                    webSocket.send(
                      buildJsonObject {
                        put("type", "res")
                        put("id", frame["id"]!!)
                        put("ok", true)
                        put("payload", result)
                      }.toString(),
                    )
                  }

                  override fun onClosing(
                    webSocket: WebSocket,
                    code: Int,
                    reason: String,
                  ) {
                    webSocket.close(code, reason)
                  }
                },
              )
          }
        start()
      }

    fun setupCode(): String =
      Base64.getUrlEncoder().withoutPadding().encodeToString(
        buildJsonObject {
          put("url", "http://127.0.0.1:${server.port}")
          put("bootstrapToken", "watch-bootstrap")
        }.toString().toByteArray(),
      )

    private fun approval(kind: String): JsonObject =
      buildJsonObject {
        put("id", kind)
        put("status", "pending")
        put("createdAtMs", 1)
        put("expiresAtMs", 9_000_000_000_000)
        put("urlPath", "/approvals/$kind")
        put(
          "presentation",
          buildJsonObject {
            put("kind", kind)
            put("allowedDecisions", Json.parseToJsonElement("""["allow-once","deny"]"""))
            when (kind) {
              "exec" -> {
                put("commandText", "printf watch")
              }

              "plugin" -> {
                put("title", "Plugin")
                put("description", "Publish watch fixture")
                put("severity", "warning")
              }

              else -> {
                put("title", "System")
                put("description", "Apply watch fixture")
                put("proposalHash", "a".repeat(64))
              }
            }
          },
        )
      }
  }
}
