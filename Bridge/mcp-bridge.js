const http = require('http');

const UNITY_PORT = process.env.UNITY_MCP_PORT || 3000;
const UNITY_HOST = process.env.UNITY_MCP_HOST || 'localhost';

// 요청 타임아웃(서버측 큐 타임아웃 30s보다 길게) / 연결거부 재시도 (도메인 리로드 윈도우 커버)
const REQUEST_TIMEOUT_MS = 45000;
const RETRY_DELAY_MS = 1500;
const MAX_RETRIES = 5;

// Enhanced logging to stderr (so it doesn't interfere with stdout JSON-RPC)
function log(msg) {
    console.error(`[Unity MCP Bridge] ${msg}`);
}

// 어떤 실패든 클라이언트에 JSON-RPC 에러를 반드시 돌려준다.
// (응답을 안 보내면 MCP 클라이언트가 해당 id를 영원히 기다리며 행이 걸림)
function sendErrorResponse(id, code, message) {
    if (id === undefined || id === null) return; // notification은 응답 불필요
    console.log(JSON.stringify({
        jsonrpc: '2.0',
        id: id,
        error: { code: code, message: message }
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

    if (parsedLine && parsedLine.method === 'notifications/initialized') {
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
    postToUnity(line, requestId, MAX_RETRIES);
});

function postToUnity(line, requestId, retriesLeft) {
    let settled = false; // 응답/에러를 정확히 1번만 처리

    const req = http.request({
        hostname: UNITY_HOST,
        port: UNITY_PORT,
        path: '/message',
        method: 'POST',
        headers: {
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
                const normalized = normalizeForMcpClient(data);
                if (normalized) {
                    console.log(normalized);
                }
            } else {
                // 200인데 빈 응답 — 서버가 리로드로 끊긴 경우
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
        sendErrorResponse(requestId, -32001, `Unity request timeout (${REQUEST_TIMEOUT_MS / 1000}s) — editor may be compiling. Retry shortly.`);
    });

    req.on('error', (e) => {
        if (settled) return;
        settled = true;

        // 연결 자체가 실패(서버 미기동/리로드 중) = 서버에 안 닿았으므로 재시도해도 안전
        const retriable = e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' || e.code === 'EPIPE';
        if (retriable && retriesLeft > 0) {
            log(`Unity unreachable (${e.code}), retrying in ${RETRY_DELAY_MS}ms... (${retriesLeft} left)`);
            setTimeout(() => postToUnity(line, requestId, retriesLeft - 1), RETRY_DELAY_MS);
            return;
        }

        log(`Error posting to Unity: ${e.message}`);
        sendErrorResponse(requestId, -32000, `Cannot reach Unity MCP server: ${e.message}`);
    });

    req.write(line);
    req.end();
}

// 2. Handle SSE from Unity -> Stdout
function connectSSE() {
    log(`Connecting to Unity at http://${UNITY_HOST}:${UNITY_PORT}/sse`);

    const req = http.request({
        hostname: UNITY_HOST,
        port: UNITY_PORT,
        path: '/sse',
        method: 'GET',
        headers: {
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
        setTimeout(connectSSE, 5000);
    });

    req.end();
}

// Start SSE listener
connectSSE();

log('Bridge started. Waiting for MCP client input...');
