import http from "k6/http";
import { check } from "k6";

const ingestUrl = __ENV.INGEST_URL || "http://127.0.0.1:3100/publish";
const runId = __ENV.RUN_ID || `run-${Date.now()}`;
const payloadBytes = Number(__ENV.PAYLOAD_BYTES || 1024);
const rate = Number(__ENV.RATE || 1000);
const duration = __ENV.DURATION || "30s";
const preAllocatedVUs = Number(__ENV.PRE_ALLOCATED_VUS || 50);
const maxVUs = Number(__ENV.MAX_VUS || 1000);

const makePayload = (size) => {
  const template = "x".repeat(Math.max(0, size));
  return template.length > size ? template.slice(0, size) : template;
};

export const options = {
  scenarios: {
    publish_load: {
      executor: "constant-arrival-rate",
      rate,
      timeUnit: "1s",
      duration,
      preAllocatedVUs,
      maxVUs
    }
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<2000"]
  }
};

const msgPayload = makePayload(payloadBytes);

export default function () {
  const body = JSON.stringify({
    id: `${__VU}-${__ITER}-${Date.now()}`,
    sentAtMs: Date.now(),
    payload: msgPayload,
    payloadBytes,
    runId
  });

  const response = http.post(ingestUrl, body, {
    headers: {
      "Content-Type": "application/json"
    }
  });

  check(response, {
    "status is 202": (r) => r.status === 202
  });
}
