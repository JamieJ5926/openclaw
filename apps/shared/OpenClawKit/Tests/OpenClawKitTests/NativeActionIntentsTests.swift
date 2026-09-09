#if os(iOS) || os(macOS)
import OpenClawKit
import Testing

struct NativeActionIntentsTests {
    @Test func `saved entity selectors preserve exact spelling`() async throws {
        let first = OpenClawNativeSessionRef(
            owner: .init(gatewayID: "gateway-e\u{301}", profileID: "profile-a"),
            agentID: "reviewer",
            sessionKey: "agent:reviewer:main")
        let second = OpenClawNativeSessionRef(
            owner: .init(gatewayID: "gateway-\u{E9}", profileID: "profile-a"),
            agentID: "reviewer",
            sessionKey: "agent:reviewer:main")
        let entities = try [OpenClawSessionEntity(session: first), OpenClawSessionEntity(session: second)]
        #expect(entities[0].id != entities[1].id)
        let resolved = try await OpenClawSessionQuery().entities(for: entities.map(\.id))
        #expect(resolved.map(\.session) == [first, second])
    }

    @Test func `unprofiled selections cannot become entities`() {
        let session = OpenClawNativeSessionRef(
            owner: .init(gatewayID: "gateway-a", profileID: ""),
            agentID: "reviewer",
            sessionKey: "agent:reviewer:main")
        #expect(throws: OpenClawNativeActionError.self) { try OpenClawSessionEntity(session: session) }
        #expect(throws: OpenClawNativeActionError.self) {
            try OpenClawRunEntity(run: .init(session: session, runID: "run-a"))
        }
    }
}
#endif
