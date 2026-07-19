const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const UNITY_PORT = process.env.UNITY_MCP_PORT || 3000;

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

// 요청 타임아웃(서버측 큐 타임아웃 30s보다 길게) / 연결거부 재시도 (도메인 리로드 윈도우 커버)
const REQUEST_TIMEOUT_MS = 45000;
const RETRY_DELAY_MS = 1500;
const MAX_RETRIES = 5;

// 하트비트: 10초 주기로 Unity에 ping을 보내 마지막 정상 응답 시각을 추적한다(에러 메시지 부가정보로만 사용).
const HEARTBEAT_INTERVAL_MS = 10000;
const HEARTBEAT_TIMEOUT_MS = 5000;
let lastAliveAt = null;      // Unity가 마지막으로 정상 응답한 시각(ms). 하트비트/정상 응답에서 갱신.
let reloadingSince = null;   // Unity가 unity/reloading 노티를 보낸 시각(ms). 내부 상태 마킹용(클라 전달 안 함).

// Enhanced logging to stderr (so it doesn't interfere with stdout JSON-RPC)
function log(msg) {
    console.error(`[Unity MCP Bridge] ${msg}`);
}

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

function normalizeForMcpClient(data) {
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

        const tools = message && message.result && message.result.tools;

        if (Array.isArray(tools)) {
            for (const tool of tools) {
                const schema = tool && tool.inputSchema;
                if (schema && typeof schema.properties === 'string') {
                    schema.properties = JSON.parse(schema.properties);
                }
            }
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
            log(`tools/list served from cache (${cached.tools.length} tools, saved ${cached.savedAt}) — ${reason}`);
            console.log(JSON.stringify({ jsonrpc: '2.0', id: requestId, result: { tools: cached.tools } }));
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
                serverInfo: { name: 'unity-mcp-bridge', version: '2.2.0' }
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

    const requestId = parsedLine ? parsedLine.id : undefined;
    postToUnity(line, requestId, MAX_RETRIES, parsedLine);
});

// 재시도해도 안전한(부작용 없는/조회성) 도구 이름 프리픽스.
const IDEMPOTENT_TOOL_PREFIXES = ['unity_get_', 'unity_list', 'unity_search', 'unity_raycast', 'unity_overlap', 'unity_take_screenshot'];

function isIdempotentTool(toolName) {
    if (!toolName) return false;
    return IDEMPOTENT_TOOL_PREFIXES.some(prefix => toolName.startsWith(prefix));
}

function postToUnity(line, requestId, retriesLeft, parsedLine) {
    let settled = false; // 응답/에러를 정확히 1번만 처리

    const req = http.request({
        hostname: currentHost(),
        port: UNITY_PORT,
        path: '/message',
        method: 'POST',
        headers: {
            'Host': hostHeaderFor(currentHost()),
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(line)
        }
    }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            if (settled) return;
            settled = true;

            if (res.statusCode !== 200) {
                log(`Unity returned error ${res.statusCode}: ${data}`);
                sendErrorResponse(requestId, -32000, `Unity HTTP ${res.statusCode}`);
            } else if (data) {
                lastAliveAt = Date.now(); // Unity가 정상 응답 — 생존 시각 갱신
                const normalized = normalizeForMcpClient(data);
                if (normalized) {
                    // tools/list 성공 결과는 디스크에 캐시 — 다음 CC 시작 때 Unity가 리로드 중이어도 목록을 낼 수 있게.
                    if (parsedLine && parsedLine.method === 'tools/list') {
                        try {
                            const parsed = JSON.parse(normalized);
                            if (parsed && parsed.result && Array.isArray(parsed.result.tools)) {
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
            setTimeout(() => postToUnity(line, requestId, retriesLeft - 1, parsedLine), RETRY_DELAY_MS);
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
        headers: {
            'Host': hostHeaderFor(currentHost()),
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
        }
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

    const req = http.request({
        hostname: currentHost(),
        port: UNITY_PORT,
        path: '/sse',
        method: 'GET',
        headers: {
            'Host': hostHeaderFor(currentHost()),
            'Accept': 'text/event-stream'
        }
    }, (res) => {
        if (res.statusCode !== 200) {
            log(`Failed to connect to SSE. Status: ${res.statusCode}`);
            setTimeout(connectSSE, 5000);
            return;
        }

        log('Connected to Unity MCP Server');

        res.on('data', (chunk) => {
            const text = chunk.toString();
            // SSE format: "data: {json}\n\n"
            const lines = text.split('\n');
            for (const line of lines) {
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

// Start SSE listener
connectSSE();

// 하트비트 시작 — 인터벌은 unref()로 이벤트 루프를 붙잡지 않게 한다(stdin 종료 시 브릿지가 자연 종료됨).
const heartbeatTimer = setInterval(heartbeatPing, HEARTBEAT_INTERVAL_MS);
if (heartbeatTimer.unref) heartbeatTimer.unref();

log(`Bridge started (Unity host candidates: ${HOST_CANDIDATES.join(', ')} port ${UNITY_PORT}). Waiting for MCP client input...`);
