const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 아웃프로세스 프로젝트 인덱스 (Phase 2). Unity 를 거치지 않고 브릿지가 직접 응답한다.
const indexTools = require('./index/tools');

const UNITY_PORT = process.env.UNITY_MCP_PORT || 3000;

// initialize 의 serverInfo.version. 상수로 박아두면 릴리스마다 어긋난다 —
// 실측(2026-08-25): package.json 이 2.3.0-dev.0.0.3 인데 핸드셰이크는 2.2.0 을 답하고 있었다.
// 버전을 묻는 쪽에 조용히 틀린 값을 주는 것이므로 패키지에서 읽는다.
const PACKAGE_VERSION = (() => {
    try {
        return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version || '0.0.0';
    } catch (e) {
        return '0.0.0';
    }
})();

// 'localhost' 단일 해석에 의존하면 서버(Mono HttpListener)가 ::1 한쪽에만 바인딩하는 환경에서
// 서버가 켜져 있어도 ECONNREFUSED가 난다(2026-07-19 실측: [::1]:3000 단독 LISTEN, IPv4 없음).
// 명시적 루프백 후보를 순환하며 마지막으로 성공한 호스트를 유지한다(sticky).
const HOST_CANDIDATES = process.env.UNITY_MCP_HOST ? [process.env.UNITY_MCP_HOST] : ['127.0.0.1', '::1'];
let hostIndex = 0;
function currentHost() { return HOST_CANDIDATES[hostIndex]; }
function rotateHost(reason) {
    if (HOST_CANDIDATES.length < 2) return;
    hostIndex = (hostIndex + 1) % HOST_CANDIDATES.length;
    log(`Switching Unity host candidate to ${currentHost()} (${reason})`);
}

// Mono HttpListener는 IPv6 리터럴 Host 헤더("[::1]:3000")를 파싱 못 해 400을 낸다(실측:
// "Invalid url: http://[:3000/..."). ::1로 접속할 땐 그 엔드포인트에 등록된 'localhost'
// 프리픽스와 매칭되도록 Host를 localhost로 보내고, IPv4는 주소 그대로 보낸다.
function hostHeaderFor(host) {
    return (host.indexOf(':') >= 0 ? 'localhost' : host) + ':' + UNITY_PORT;
}

// tools/list 결과 디스크 캐시 — Unity가 컴파일/리로드 중이라 응답 못 해도
// 마지막으로 성공한 도구 목록을 돌려줘 MCP 연결 수립이 Unity 타이밍에 인질로 잡히지 않게 한다.
const TOOLS_CACHE_PATH = path.join(os.homedir(), '.unity-mcp', 'tools-cache.json');

// 세션 토큰 — Unity(McpAuthToken)가 서버 시작 시 기록한다. 브라우저는 이 파일을 읽을 수 없으므로
// 헤더를 만들 수 없고, 그래서 사용자가 열어 둔 웹페이지가 이 서버를 호출할 수 없다.
// 사용자가 창에서 명시적으로 Stop 하면 토큰이 폐기되고 새로 생성되므로, 401 을 받으면 한 번 다시 읽는다.
const AUTH_TOKEN_HEADER = 'X-Unity-MCP-Token';
function authTokenPath() {
    return path.join(os.homedir(), '.unity-mcp', `auth-token-${UNITY_PORT}.json`);
}
let cachedAuthToken = null;
function readAuthToken(forceReload) {
    if (cachedAuthToken && !forceReload) return cachedAuthToken;
    try {
        const parsed = JSON.parse(fs.readFileSync(authTokenPath(), 'utf8'));
        if (parsed && typeof parsed.token === 'string' && parsed.token.length > 0) {
            cachedAuthToken = parsed.token;
            return cachedAuthToken;
        }
    } catch (e) { /* 파일 없음 — 구버전 서버이거나 토큰 기록 실패. 헤더 없이 진행한다. */ }
    cachedAuthToken = null;
    return null;
}

// Unity 로 보내는 모든 요청의 공통 헤더. 토큰이 있으면 실어 보낸다.
function unityHeaders(payloadLength) {
    const headers = {
        'Host': hostHeaderFor(currentHost()),
        'Content-Type': 'application/json',
        'Content-Length': payloadLength
    };
    const token = readAuthToken(false);
    if (token) headers[AUTH_TOKEN_HEADER] = token;
    return headers;
}

// 요청 타임아웃(서버측 큐 타임아웃 30s보다 길게) / 연결거부 재시도 (도메인 리로드 윈도우 커버)
const REQUEST_TIMEOUT_MS = 45000;
const RETRY_DELAY_MS = 1500;
const MAX_RETRIES = 5;

// Unity가 "지금 바쁘다"고 HTTP 200으로 즉답하는 코드(-32001: 컴파일/도메인 리로드 중).
// 이건 실패가 아니라 "잠시 뒤 다시"라는 뜻이므로, 멱등 요청에 한해 브릿지가 대신 재시도한다.
// 그대로 클라이언트에 올리면 컴파일 중 호출이 전부 실패로 끝난다.
const UNITY_BUSY_CODE = -32001;
const BUSY_RETRY_DELAY_MS = 2000;
const MAX_BUSY_RETRIES = 8; // 약 16초 — 일반적인 스크립트 컴파일/도메인 리로드 구간을 덮는다.

// 하트비트: 10초 주기로 Unity에 ping을 보내 마지막 정상 응답 시각을 추적한다(에러 메시지 부가정보로만 사용).
const HEARTBEAT_INTERVAL_MS = 10000;
const HEARTBEAT_TIMEOUT_MS = 5000;
let lastAliveAt = null;      // Unity가 마지막으로 정상 응답한 시각(ms). 하트비트/정상 응답에서 갱신.
let reloadingSince = null;   // Unity가 unity/reloading 노티를 보낸 시각(ms). 내부 상태 마킹용(클라 전달 안 함).

// Enhanced logging to stderr (so it doesn't interfere with stdout JSON-RPC)
function log(msg) {
    console.error(`[Unity MCP Bridge] ${msg}`);
}

indexTools.setLogger(log);

// 어떤 실패든 클라이언트에 JSON-RPC 에러를 반드시 돌려준다.
// (응답을 안 보내면 MCP 클라이언트가 해당 id를 영원히 기다리며 행이 걸림)
function sendErrorResponse(id, code, message) {
    if (id === undefined || id === null) return; // notification은 응답 불필요
    let fullMessage = message;
    if (lastAliveAt) {
        const agoSec = Math.round((Date.now() - lastAliveAt) / 1000);
        fullMessage = `${message} (Unity last responded ${agoSec}s ago)`;
    }
    console.log(JSON.stringify({
        jsonrpc: '2.0',
        id: id,
        error: { code: code, message: fullMessage }
    }));
}

// tools/list 는 매 세션 한 번씩 통째로 오가는 고정비다(이 프로젝트 기준 81개 도구 ~40 KB).
// MCP 스펙이 정한 기본값과 같은 힌트는 실어봐야 의미가 없으므로 뺀다.
//   readOnlyHint 기본 false / destructiveHint 기본 **true** / idempotentHint 기본 false
// destructiveHint 는 기본이 true 라는 점이 함정이다 — false 를 생략하면 안전한 도구가
// 파괴적으로 뒤집히고, true 를 생략하면 읽는 쪽이 기본값을 적용해야 맞는다.
// 그래서 이 파일의 isIdempotentTool 도 생략된 필드에 기본값을 적용하도록 맞춰 뒀다.
function slimToolList(tools) {
    for (const tool of tools) {
        if (!tool) continue;
        const a = tool.annotations;
        if (a) {
            const slim = {};
            if (a.readOnlyHint) {
                slim.readOnlyHint = true;              // 기본 false 와 다르므로 명시
            } else if (a.destructiveHint === false) {
                slim.destructiveHint = false;          // 기본 true 와 다르므로 명시
            } else {
                // 기본값과 같지만 일부러 싣는다. 생략 규칙을 여기서만 깨는 이유:
                // 기본값을 생략하면 읽는 쪽이 기본값을 적용해야 뜻이 보존되는데, 그걸 안 하는
                // 클라이언트가 있을 때 방향이 문제다. readOnlyHint 를 빼면 최악이 "안전한 툴을
                // 한 번 더 확인"(과잉 경고)이고, destructiveHint 를 빼면 최악이 "파괴적 툴을 경고 없이
                // 실행"(과소 경고)이다. 후자는 되돌릴 수 없다.
                // 2026-08-23 실측: 이 10개를 명시하는 비용은 390 B (전체 37 KB 의 1.1%).
                slim.destructiveHint = true;
            }
            if (a.idempotentHint) slim.idempotentHint = true;
            if (Object.keys(slim).length > 0) tool.annotations = slim;
            else delete tool.annotations;
        }
        // JsonUtility 는 빈 배열도 그대로 내보낸다. required:[] 는 필드 부재와 같은 뜻이다.
        const schema = tool.inputSchema;
        if (schema && Array.isArray(schema.required) && schema.required.length === 0) {
            delete schema.required;
        }
    }
}

function normalizeForMcpClient(data, expectedId) {
    try {
        const message = JSON.parse(data);
        if (message && message.result && message.result.capabilities) {
            // The Unity endpoint advertises resources, and some clients probe
            // prompts even though the endpoint does not implement them. Keep the
            // bridge focused on tools so Codex can complete startup cleanly.
            delete message.result.capabilities.resources;
            delete message.result.capabilities.prompts;
        }

        if (
            message &&
            message.id == null &&
            message.error &&
            message.error.code === -32601 &&
            typeof message.error.message === 'string' &&
            message.error.message.includes('notifications/initialized')
        ) {
            return null;
        }

        // ⚠️ 무한대기 방어. Unity 서버가 합성한 에러 응답은 요청 id를 잃어버릴 수 있다
        //    (본문을 읽기 전에 실패한 경로, 또는 id 보존 수정이 없는 구버전 서버).
        //    id 없는 응답을 그대로 올리면 클라이언트는 자기 요청과 매칭하지 못해 응답이 온 줄도 모르고
        //    자기 타임아웃(예: 120s)까지 매달린다. 브릿지는 이 요청의 id를 알고 있으므로 교정해서 올린다.
        if (message && message.id == null && message.error &&
            expectedId !== undefined && expectedId !== null) {
            message.id = expectedId;
            log(`Repaired id-less error response from Unity -> id=${expectedId} (code=${message.error.code})`);
        }

        const tools = message && message.result && message.result.tools;

        if (Array.isArray(tools)) {
            for (const tool of tools) {
                const schema = tool && tool.inputSchema;
                if (schema && typeof schema.properties === 'string') {
                    schema.properties = JSON.parse(schema.properties);
                }
            }

            // 브릿지가 로컬에서 처리하는 인덱스 도구를 목록에 합친다.
            // Unity 가 모르는 도구이므로 서버 응답에는 없다.
            const known = new Set(tools.map(t => t && t.name));
            for (const local of indexTools.toolDefinitions()) {
                if (!known.has(local.name)) tools.push(local);
            }

            slimToolList(tools);
        }

        return JSON.stringify(message);
    } catch (e) {
        log(`Schema normalization skipped: ${e.message}`);
        return data;
    }
}

function saveToolsCache(toolsArray) {
    try {
        fs.mkdir(path.dirname(TOOLS_CACHE_PATH), { recursive: true }, () => {
            fs.writeFile(TOOLS_CACHE_PATH,
                JSON.stringify({ savedAt: new Date().toISOString(), tools: toolsArray }),
                () => {});
        });
    } catch (e) { /* best-effort */ }
}

function tryServeToolsFromCache(requestId, reason) {
    try {
        const cached = JSON.parse(fs.readFileSync(TOOLS_CACHE_PATH, 'utf8'));
        if (cached && Array.isArray(cached.tools) && cached.tools.length > 0) {
            // 로컬(브릿지) 도구는 캐시가 아니라 **지금 코드**에서 다시 만든다.
            // 캐시를 그대로 내면 패키지를 올려 도구를 추가/수정해도 Unity 가 꺼져 있거나
            // 리로드 중인 동안에는 옛 목록이 나간다 — 실측(2026-08-24): 이번에 추가한
            // unity_get_asset_components 가 목록에서 통째로 빠졌다. 로컬 도구는 Unity 없이
            // 동작하는 것이 존재 이유이므로, 하필 Unity 가 없을 때 사라지면 안 된다.
            const tools = cached.tools.filter(t => !(t && indexTools.isLocalTool(t.name)));
            const fromCache = cached.tools.length - tools.length;
            for (const local of indexTools.toolDefinitions()) tools.push(local);
            slimToolList(tools);

            recordAnnotations(tools);
            log(`tools/list served from cache (${tools.length} tools, saved ${cached.savedAt}, ` +
                `${fromCache} cached local defs replaced with current ones) — ${reason}`);
            console.log(JSON.stringify({ jsonrpc: '2.0', id: requestId, result: { tools } }));
            return true;
        }
    } catch (e) { /* 캐시 없음/손상 — 폴백 불가 */ }
    return false;
}

// 1. Handle Stdin -> POST to Unity
const readline = require('readline');
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
});

rl.on('line', (line) => {
    if (!line.trim()) return;

    let parsedLine;
    try {
        parsedLine = JSON.parse(line);
    } catch (e) {
        parsedLine = null;
    }

    // MCP 핸드셰이크는 브릿지가 즉답한다 — 연결 수립이 Unity의 컴파일/리로드 타이밍에 좌우되지 않게.
    // (기존에는 initialize도 Unity까지 왕복시켜, CC 시작 순간 Unity가 리로드 중이면 서버 전체가 '연결 실패'로 마킹됐다)
    if (parsedLine && parsedLine.id !== undefined && parsedLine.method === 'initialize') {
        const requestedVersion = (parsedLine.params && parsedLine.params.protocolVersion) || '2024-11-05';
        console.log(JSON.stringify({
            jsonrpc: '2.0',
            id: parsedLine.id,
            result: {
                protocolVersion: requestedVersion,
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: 'unity-mcp-bridge', version: PACKAGE_VERSION }
            }
        }));
        return;
    }

    // MCP 레벨 ping도 로컬 즉답(브릿지 생존 확인 용도 — Unity 생존은 하트비트가 별도 추적).
    if (parsedLine && parsedLine.id !== undefined && parsedLine.method === 'ping') {
        console.log(JSON.stringify({ jsonrpc: '2.0', id: parsedLine.id, result: {} }));
        return;
    }

    // 모든 notification(id 없음)은 로컬에서 소화 — Unity로 보내면 -32601 노이즈만 생긴다.
    if (parsedLine && parsedLine.id === undefined && typeof parsedLine.method === 'string') {
        return;
    }

    if (parsedLine && parsedLine.method === 'prompts/list') {
        console.log(JSON.stringify({
            jsonrpc: '2.0',
            id: parsedLine.id,
            result: { prompts: [] },
        }));
        return;
    }

    // 인덱스 도구는 브릿지가 로컬에서 처리한다 — Unity 로 보내지 않는다.
    // 그래서 에디터가 컴파일/리로드 중이어도 응답하고, 메인 스레드 30초 캡과 무관하다.
    if (parsedLine && parsedLine.method === 'tools/call' &&
        parsedLine.params && indexTools.isLocalTool(parsedLine.params.name)) {
        let result;
        try {
            result = indexTools.callLocalTool(parsedLine.params.name, parsedLine.params.arguments, UNITY_PORT);
        } catch (e) {
            log(`local tool '${parsedLine.params.name}' threw: ${e && e.stack ? e.stack : e}`);
            result = {
                content: [{ type: 'text', text: JSON.stringify({ error: `Index tool failed: ${e && e.message ? e.message : e}` }) }],
                isError: true,
            };
        }
        console.log(JSON.stringify({ jsonrpc: '2.0', id: parsedLine.id, result }));
        return;
    }

    const requestId = parsedLine ? parsedLine.id : undefined;
    postToUnity(line, requestId, MAX_RETRIES, parsedLine);
});

// 도구별 MCP annotations (readOnlyHint / destructiveHint / idempotentHint).
// tools/list 결과와 디스크 캐시에서 채운다. 서버가 실제로 선언한 값이므로
// 이름 프리픽스 추측보다 정확하다.
const toolAnnotations = new Map();

function recordAnnotations(tools) {
    if (!Array.isArray(tools)) return;
    for (const t of tools) {
        if (t && typeof t.name === 'string' && t.annotations) {
            toolAnnotations.set(t.name, t.annotations);
        }
    }
}

// annotations 를 아직 모르는 도구(첫 tools/list 이전, 또는 구버전 서버)를 위한 폴백.
// 프리픽스 추측이므로 부정확하다 — annotations 가 있으면 항상 그쪽을 쓴다.
const IDEMPOTENT_TOOL_PREFIXES = ['unity_get_', 'unity_list', 'unity_search', 'unity_raycast', 'unity_overlap', 'unity_take_screenshot'];

function isIdempotentTool(toolName) {
    if (!toolName) return false;

    const ann = toolAnnotations.get(toolName);
    if (ann) {
        // 읽기 전용이거나 멱등이면 재전송해도 중복 부작용이 없다.
        // 파괴적이라고 선언된 도구는 멱등 표시가 있어도 재시도하지 않는다.
        // 힌트가 생략돼 있으면 MCP 스펙 기본값을 적용한다 — destructiveHint 는 기본이
        // true 라서, 없다고 비파괴로 읽으면 파괴적 도구를 재전송하게 된다.
        if (ann.readOnlyHint) return true;
        if (ann.destructiveHint !== false) return false;
        return !!ann.idempotentHint;
    }

    return IDEMPOTENT_TOOL_PREFIXES.some(prefix => toolName.startsWith(prefix));
}

// 이 요청을 다시 보내도 안전한가. tools/call이 아니면(initialize·tools/list·ping 등) 부작용이 없고,
// tools/call이면 조회성 프리픽스를 가진 멱등 도구일 때만 안전하다.
function isRetriableRequest(parsedLine) {
    if (!parsedLine) return false;
    if (parsedLine.method !== 'tools/call') return true;
    return isIdempotentTool(parsedLine.params && parsedLine.params.name);
}

// Unity가 HTTP 200으로 돌려준 "바쁨"(-32001) 응답이면 그 메시지를, 아니면 null을 돌려준다.
function parseBusyError(data) {
    try {
        const message = JSON.parse(data);
        if (message && message.error && message.error.code === UNITY_BUSY_CODE) {
            return message.error.message || 'busy';
        }
    } catch (e) { /* 파싱 불가 — 바쁨 응답으로 취급하지 않는다 */ }
    return null;
}

function postToUnity(line, requestId, retriesLeft, parsedLine, busyRetriesLeft, authRetried) {
    if (busyRetriesLeft === undefined) busyRetriesLeft = MAX_BUSY_RETRIES;
    let settled = false; // 응답/에러를 정확히 1번만 처리

    const req = http.request({
        hostname: currentHost(),
        port: UNITY_PORT,
        path: '/message',
        method: 'POST',
        headers: unityHeaders(Buffer.byteLength(line))
    }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            if (settled) return;
            settled = true;

            if (res.statusCode === 401 && !authRetried) {
                // 토큰이 회전했을 수 있다(사용자가 Stop 후 재시작). 파일을 다시 읽고 한 번만 재시도한다.
                const before = cachedAuthToken;
                const after = readAuthToken(true);
                if (after && after !== before) {
                    log('Unity rejected the session token — reloaded token file, retrying once.');
                    postToUnity(line, requestId, retriesLeft, parsedLine, busyRetriesLeft, true);
                    return;
                }
                log(`Unity returned 401 and no fresh token was available: ${data}`);
                sendErrorResponse(requestId, -32000,
                    'Unauthorized by Unity MCP server. Restart the MCP server from the Unity window (Window > MCP Server) to regenerate the session token.');
            } else if (res.statusCode !== 200) {
                log(`Unity returned error ${res.statusCode}: ${data}`);
                sendErrorResponse(requestId, -32000, `Unity HTTP ${res.statusCode}`);
            } else if (data) {
                lastAliveAt = Date.now(); // Unity가 정상 응답 — 생존 시각 갱신

                // Unity가 "컴파일/리로드 중이라 못 받는다"(-32001)고 즉답한 경우.
                // HTTP는 200이라 아래 타임아웃·재시도 경로가 전혀 걸리지 않으므로 여기서 직접 재시도한다.
                // (요청은 큐에 들어가지도 않았으므로 멱등 요청이면 다시 보내도 중복 실행 위험이 없다.)
                const busyMessage = parseBusyError(data);
                if (busyMessage && busyRetriesLeft > 0 && isRetriableRequest(parsedLine)) {
                    log(`Unity busy ("${busyMessage}") — retrying in ${BUSY_RETRY_DELAY_MS}ms... (${busyRetriesLeft} left)`);
                    setTimeout(
                        () => postToUnity(line, requestId, retriesLeft, parsedLine, busyRetriesLeft - 1),
                        BUSY_RETRY_DELAY_MS);
                    return;
                }
                if (busyMessage && busyRetriesLeft <= 0) {
                    log(`Unity still busy after ${MAX_BUSY_RETRIES} retries — giving up and reporting to client.`);
                }

                const normalized = normalizeForMcpClient(data, requestId);
                if (normalized) {
                    // tools/list 성공 결과는 디스크에 캐시 — 다음 CC 시작 때 Unity가 리로드 중이어도 목록을 낼 수 있게.
                    if (parsedLine && parsedLine.method === 'tools/list') {
                        try {
                            const parsed = JSON.parse(normalized);
                            if (parsed && parsed.result && Array.isArray(parsed.result.tools)) {
                                recordAnnotations(parsed.result.tools);
                                saveToolsCache(parsed.result.tools);
                            }
                        } catch (e) { /* best-effort */ }
                    }
                    console.log(normalized);
                }
            } else {
                // 200인데 빈 응답 — 서버가 리로드로 끊긴 경우
                if (parsedLine && parsedLine.method === 'tools/list' && tryServeToolsFromCache(requestId, 'empty response (reloading?)')) return;
                sendErrorResponse(requestId, -32000, 'Empty response from Unity (editor reloading?)');
            }
        });
        res.on('error', (e) => {
            if (settled) return;
            settled = true;
            log(`Response stream error: ${e.message}`);
            sendErrorResponse(requestId, -32000, `Unity response error: ${e.message}`);
        });
    });

    // 타임아웃: 서버가 받고도 응답 못 주는 경우(컴파일로 메인스레드 정지 등).
    // 서버가 요청을 이미 받았을 수 있으므로 재시도하지 않는다(중복 실행 방지).
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        if (settled) return;
        settled = true;
        req.destroy();
        log(`Request timeout after ${REQUEST_TIMEOUT_MS}ms`);
        if (parsedLine && parsedLine.method === 'tools/list' && tryServeToolsFromCache(requestId, 'request timeout')) return;
        sendErrorResponse(requestId, -32001, `Unity request timeout (${REQUEST_TIMEOUT_MS / 1000}s) — editor may be compiling. Retry shortly.`);
    });

    req.on('error', (e) => {
        if (settled) return;
        settled = true;

        const method = parsedLine && parsedLine.method;
        const toolName = method === 'tools/call' && parsedLine.params ? parsedLine.params.name : undefined;

        // ECONNREFUSED = 연결 자체가 실패(서버 미기동/리로드 중) = 요청이 Unity에 닿지 않았으므로 항상 재시도해도 안전.
        // ECONNRESET/EPIPE = 연결이 맺어진 뒤 끊긴 것이라 요청이 이미 Unity에 도달했을 수 있다.
        //   tools/call이 아니면(initialize/tools list/ping 등 부작용 없음) 재시도.
        //   tools/call이면 조회성 프리픽스(unity_get_ 등)로 시작하는 멱등 도구일 때만 재시도 —
        //   그 외는 이미 실행됐을 수 있어 재시도 시 중복 실행 위험이 있으므로 재시도하지 않는다.
        let retriable;
        if (e.code === 'ECONNREFUSED') {
            retriable = true;
        } else if (e.code === 'ECONNRESET' || e.code === 'EPIPE') {
            retriable = method !== 'tools/call' || isIdempotentTool(toolName);
        } else {
            retriable = false;
        }

        if (retriable && retriesLeft > 0) {
            // 연결 거부는 반대쪽 루프백(::1↔127.0.0.1)에 서버가 있을 수 있으므로 후보를 바꿔 재시도.
            if (e.code === 'ECONNREFUSED') {
                const failedHost = currentHost();
                rotateHost(`ECONNREFUSED on ${failedHost}`);
            }
            log(`Unity unreachable (${e.code}), retrying in ${RETRY_DELAY_MS}ms... (${retriesLeft} left)`);
            setTimeout(
                () => postToUnity(line, requestId, retriesLeft - 1, parsedLine, busyRetriesLeft),
                RETRY_DELAY_MS);
            return;
        }

        if (!retriable && (e.code === 'ECONNRESET' || e.code === 'EPIPE')) {
            log(`Not retrying ${e.code} for tool '${toolName}' — request may have already reached Unity.`);
            sendErrorResponse(requestId, -32000,
                `Connection lost after request may have reached Unity — not retried to avoid duplicate side effects (tool: ${toolName}). Verify state and retry manually if safe.`);
            return;
        }

        if (parsedLine && parsedLine.method === 'tools/list' && tryServeToolsFromCache(requestId, `unreachable: ${e.code || e.message}`)) return;
        log(`Error posting to Unity: ${e.message}`);
        sendErrorResponse(requestId, -32000, `Cannot reach Unity MCP server: ${e.message}`);
    });

    req.write(line);
    req.end();
}

// 하트비트: postToUnity를 재사용하지 않는 전용 경량 요청으로 Unity 생존을 확인한다.
// 응답은 절대 stdout으로 내보내지 않는다(stdio JSON-RPC 프로토콜 오염 방지). 성공 시 lastAliveAt만 갱신.
function heartbeatPing() {
    const payload = JSON.stringify({ jsonrpc: '2.0', id: '__hb', method: 'ping' });
    const req = http.request({
        hostname: currentHost(),
        port: UNITY_PORT,
        path: '/message',
        method: 'POST',
        headers: unityHeaders(Buffer.byteLength(payload))
    }, (res) => {
        // 본문은 소비만 하고 버린다(stdout 출력 없음).
        res.on('data', () => {});
        res.on('end', () => {
            if (res.statusCode === 200) {
                lastAliveAt = Date.now();
            }
        });
        res.on('error', () => {});
    });
    req.setTimeout(HEARTBEAT_TIMEOUT_MS, () => {
        try { req.destroy(); } catch (e) {}
    });
    req.on('error', (e) => {
        // Unity 미응답(리로드/미기동) — lastAliveAt 갱신하지 않음.
        // 연결 거부면 다음 시도가 반대쪽 루프백을 찍도록 후보 순환(sticky host 자가 교정).
        if (e && e.code === 'ECONNREFUSED') {
            const failedHost = currentHost();
            rotateHost(`heartbeat ECONNREFUSED on ${failedHost}`);
        }
    });
    req.write(payload);
    req.end();
}

// 2. Handle SSE from Unity -> Stdout
function connectSSE() {
    log(`Connecting to Unity at http://${currentHost()}:${UNITY_PORT}/sse`);

    const sseHeaders = {
        'Host': hostHeaderFor(currentHost()),
        'Accept': 'text/event-stream'
    };
    const sseToken = readAuthToken(false);
    if (sseToken) sseHeaders[AUTH_TOKEN_HEADER] = sseToken;

    const req = http.request({
        hostname: currentHost(),
        port: UNITY_PORT,
        path: '/sse',
        method: 'GET',
        headers: sseHeaders
    }, (res) => {
        if (res.statusCode === 401) {
            // 토큰 회전 가능성 — 다시 읽고 재연결한다.
            log('SSE unauthorized — reloading session token and reconnecting.');
            readAuthToken(true);
            setTimeout(connectSSE, 2000);
            return;
        }
        if (res.statusCode !== 200) {
            log(`Failed to connect to SSE. Status: ${res.statusCode}`);
            setTimeout(connectSSE, 5000);
            return;
        }

        log('Connected to Unity MCP Server');

        // ⚠️ 청크 경계 유실 방어. 기존 코드는 chunk 마다 독립적으로 split('\n') 했다.
        //    TCP 청크는 SSE 이벤트 경계와 무관하게 쪼개지므로, "data: {...}" 한 줄이
        //    두 청크에 걸치면 양쪽 조각 모두 startsWith('data: ') / JSON.parse 에 실패해
        //    그 이벤트가 조용히 사라졌다. 완전한 줄만 처리하고 나머지는 버퍼에 남긴다.
        let sseBuffer = '';

        res.on('data', (chunk) => {
            sseBuffer += chunk.toString();

            let nl;
            const lines = [];
            while ((nl = sseBuffer.indexOf('\n')) >= 0) {
                lines.push(sseBuffer.slice(0, nl));
                sseBuffer = sseBuffer.slice(nl + 1);
            }
            // sseBuffer 에 남은 것은 아직 개행이 오지 않은 불완전한 줄이다. 다음 청크와 합쳐진다.

            for (const rawLine of lines) {
                const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
                if (line.startsWith('data: ')) {
                    const json = line.substring(6).trim();
                    if (json) {
                        // unity/reloading 노티는 내부 상태만 마킹하고 MCP 클라이언트로는 전달하지 않는다(추가적 알림, 오염 방지).
                        let parsed = null;
                        try { parsed = JSON.parse(json); } catch (e) {}
                        if (parsed && parsed.method === 'unity/reloading') {
                            reloadingSince = Date.now();
                            log('Unity signaled domain reload (unity/reloading) — expecting a brief disconnect.');
                            continue;
                        }
                        // Forward to MCP client via stdout
                        const normalized = normalizeForMcpClient(json);
                        if (normalized) {
                            console.log(normalized);
                        }
                    }
                }
            }
        });

        res.on('end', () => {
            log('SSE Connection closed. Reconnecting...');
            setTimeout(connectSSE, 1000);
        });

        res.on('error', (e) => {
            log(`SSE stream error: ${e.message}. Reconnecting...`);
            setTimeout(connectSSE, 2000);
        });
    });

    req.on('error', (e) => {
        if (e && e.code === 'ECONNREFUSED') {
            const failedHost = currentHost();
            rotateHost(`SSE ECONNREFUSED on ${failedHost}`);
        }
        setTimeout(connectSSE, 5000);
    });

    req.end();
}

// 시작 시 디스크 캐시에서 annotations 를 미리 읽는다. 첫 tools/list 이전에 들어온
// tools/call 에 대해서도 프리픽스 추측 대신 실제 선언값으로 재시도를 판단하기 위함.
try {
    const cached = JSON.parse(fs.readFileSync(TOOLS_CACHE_PATH, 'utf8'));
    if (cached && Array.isArray(cached.tools)) {
        recordAnnotations(cached.tools);
        log(`Preloaded annotations for ${toolAnnotations.size} tools from cache.`);
    }
} catch (e) { /* 캐시 없음 — 폴백 휴리스틱을 쓴다 */ }

// Start SSE listener
connectSSE();

// 하트비트 시작 — 인터벌은 unref()로 이벤트 루프를 붙잡지 않게 한다(stdin 종료 시 브릿지가 자연 종료됨).
const heartbeatTimer = setInterval(heartbeatPing, HEARTBEAT_INTERVAL_MS);
if (heartbeatTimer.unref) heartbeatTimer.unref();

log(`Bridge started (Unity host candidates: ${HOST_CANDIDATES.join(', ')} port ${UNITY_PORT}). Waiting for MCP client input...`);
