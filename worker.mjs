// Gemini 3 Pro / OpenAI 兼容接口 - Cloudflare Worker 完整版
// 已移除 node:buffer 报错，增加首页状态显示

export default {
  async fetch (request) {
    // 1. 处理 OPTIONS 预检请求 (解决跨域问题)
    if (request.method === "OPTIONS") {
      return handleOPTIONS();
    }

    const url = new URL(request.url);
    const { pathname } = url;

    // 2. 首页状态检查 (解决打开是 404 的问题)
    if (pathname === "/" || pathname === "/health") {
      return new Response(JSON.stringify({
        status: "Success",
        message: "Gemini 3 Pro Proxy is Active! 🚀",
        guide: "Please set Base URL to: " + url.origin + "/v1",
        model_support: "gemini-3-pro-preview, gemini-2.0-flash-exp, gemini-1.5-pro"
      }, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    const errHandler = (err) => {
      console.error(err);
      return new Response(JSON.stringify({ error: { message: err.message, type: "internal_error" } }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    };

    try {
      const auth = request.headers.get("Authorization");
      const apiKey = auth?.split(" ")[1];
      
      // 路由分发
      switch (true) {
        case pathname.endsWith("/chat/completions"):
          if (request.method !== "POST") throw new Error("Method Not Allowed");
          return handleCompletions(await request.json(), apiKey).catch(errHandler);
          
        case pathname.endsWith("/embeddings"):
          if (request.method !== "POST") throw new Error("Method Not Allowed");
          return handleEmbeddings(await request.json(), apiKey).catch(errHandler);
          
        case pathname.endsWith("/models"):
          return handleModels(apiKey).catch(errHandler);
          
        default:
          return new Response("404 Not Found (Check your endpoint path, usually /v1/chat/completions)", { status: 404 });
      }
    } catch (err) {
      return errHandler(err);
    }
  }
};

// === 核心逻辑部分 ===

const BASE_URL = "https://generativelanguage.googleapis.com";
const API_VERSION = "v1beta"; // Gemini 3 Pro 通常在 beta 版本可用

// 默认模型设置：如果客户端不传模型，默认用这个
const DEFAULT_MODEL = "gemini-3-pro-preview"; 

// 辅助：处理 CORS
const fixCors = (response) => {
  const newHeaders = new Headers(response.headers);
  newHeaders.set("Access-Control-Allow-Origin", "*");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders
  });
};

const handleOPTIONS = async () => {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    }
  });
};

async function handleModels (apiKey) {
  // 这里我们手动列出支持的模型，方便客户端识别
  const models = [
    { id: "gemini-3-pro-preview", object: "model", created: 1731974400, owned_by: "google" },
    { id: "gemini-2.0-flash-exp", object: "model", created: 1731974400, owned_by: "google" },
    { id: "gemini-1.5-pro", object: "model", created: 1715644800, owned_by: "google" },
    { id: "gemini-1.5-flash", object: "model", created: 1715644800, owned_by: "google" }
  ];
  return new Response(JSON.stringify({ object: "list", data: models }), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

async function handleCompletions (req, apiKey) {
  let model = req.model || DEFAULT_MODEL;
  
  // 智能模型名称映射 (防止客户端乱传)
  if (model.includes("gpt")) model = DEFAULT_MODEL; 
  if (model === "gemini-3-pro") model = "gemini-3-pro-preview"; // 修正名称
  
  // 处理模型前缀
  const cleanModel = model.replace(/^models\//, "").replace(/^gemini-/, "gemini-");
  const finalModel = cleanModel.startsWith("gemini-") ? cleanModel : "gemini-" + cleanModel;

  const url = `${BASE_URL}/${API_VERSION}/models/${finalModel}:${req.stream ? "streamGenerateContent" : "generateContent"}?alt=sse&key=${apiKey}`;

  const body = await transformRequest(req);

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    return fixCors(response);
  }

  // 流式处理或普通返回
  if (req.stream) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const reader = response.body.getReader();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    // 异步处理流
    (async () => {
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (buffer) processChunk(buffer, writer, encoder, model);
          await writer.write(encoder.encode("data: [DONE]\n\n"));
          await writer.close();
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop(); 
        for (const line of lines) {
           processChunk(line, writer, encoder, model);
        }
      }
    })();

    return new Response(readable, {
      headers: { "Content-Type": "text/event-stream", "Access-Control-Allow-Origin": "*" }
    });
  } else {
    // 非流式
    const json = await response.json();
    const openaiResponse = transformResponse(json, model);
    return new Response(JSON.stringify(openaiResponse), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }
}

// === 核心数据转换工具 (OpenAI <-> Gemini) ===

async function transformRequest(req) {
  const contents = [];
  let systemInstruction = undefined;

  for (const msg of req.messages) {
    if (msg.role === "system") {
      systemInstruction = { parts: [{ text: msg.content }] };
    } else {
      const parts = [];
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "text") parts.push({ text: part.text });
          if (part.type === "image_url") {
            const imgData = await fetchImageAsBase64(part.image_url.url);
            parts.push({ inlineData: { mimeType: "image/jpeg", data: imgData } });
          }
        }
      } else {
        parts.push({ text: msg.content });
      }
      contents.push({ role: msg.role === "assistant" ? "model" : "user", parts });
    }
  }

  return {
    contents,
    systemInstruction,
    generationConfig: {
      temperature: req.temperature,
      maxOutputTokens: req.max_tokens,
    }
  };
}

// 辅助：下载图片并转Base64 (原生 fetch，不依赖 node:buffer)
async function fetchImageAsBase64(url) {
  const resp = await fetch(url);
  const arrayBuffer = await resp.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(arrayBuffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// 处理流式 Chunk
function processChunk(line, writer, encoder, model) {
  if (!line.startsWith("data: ")) return;
  try {
    const data = JSON.parse(line.slice(6));
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) {
      const chunk = {
        id: "chatcmpl-" + Date.now(),
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
      };
      writer.write(encoder.encode("data: " + JSON.stringify(chunk) + "\n\n"));
    }
  } catch (e) { }
}

// 处理普通响应
function transformResponse(data, model) {
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return {
    id: "chatcmpl-" + Date.now(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } // Gemini API 返回的 usage 格式不同，这里简化处理
  };
}

async function handleEmbeddings(req) {
   return new Response(JSON.stringify({ error: "Embeddings not supported in this simplified version" }), { status: 400 });
}
