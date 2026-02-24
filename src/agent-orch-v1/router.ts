import type { OpenClawConfig } from "../config/config.js";
import {
  buildRouteEnvelopeDiagnostics,
  parseRouteEnvelope,
  type RouteEnvelope,
  type RouteEnvelopeDiagnostics,
} from "./route-envelope.js";
import { resolveZulipRoutingDestination } from "./zulip-routing-adapter.js";

export type RoutingAdapter = {
  channel: "zulip";
  resolve: (params: {
    cfg: OpenClawConfig;
    envelope: RouteEnvelope;
  }) => { ok: true; stream: string } | { ok: false; reason: string };
};

export type RoutingOriginContext = {
  channel: "zulip";
  stream: string;
  topic: string;
};

export type RoutingStructuredErrorPayload = {
  ok: false;
  error: {
    code: "routing_origin_missing";
    dropReason: "routing_failure";
    message: string;
    reason: string;
    project: string;
    role: string;
    instance: string;
  };
};

export type RouteSendPlan =
  | {
      kind: "resolved";
      channel: "zulip";
      target: string;
      threadId: string;
      envelope: RouteEnvelope;
    }
  | {
      kind: "fallback";
      channel: "zulip";
      target: string;
      threadId: string;
      reason: string;
      diagnostics: RouteEnvelopeDiagnostics;
      diagnosticTag: string;
    }
  | {
      kind: "error";
      payload: RoutingStructuredErrorPayload;
    };

const ZULIP_ROUTING_ADAPTER: RoutingAdapter = {
  channel: "zulip",
  resolve: ({ cfg, envelope }) => resolveZulipRoutingDestination({ cfg, envelope }),
};

function normalizeOriginContext(
  origin: RoutingOriginContext | null | undefined,
): RoutingOriginContext | null {
  if (!origin) {
    return null;
  }
  const stream = origin.stream.trim();
  const topic = origin.topic.trim();
  if (!stream || !topic) {
    return null;
  }
  return {
    channel: "zulip",
    stream,
    topic,
  };
}

function buildRoutingFailureTag(params: {
  reason: string;
  diagnostics: RouteEnvelopeDiagnostics;
}): string {
  return (
    `[routing-failure] reason=${params.reason} ` +
    `project=${params.diagnostics.project} role=${params.diagnostics.role} ` +
    `instance=${params.diagnostics.instance}`
  );
}

export function buildRoutingFailureFallbackMessage(params: {
  diagnosticTag: string;
  originalMessage?: string;
}): string {
  const original = (params.originalMessage ?? "").trim();
  if (!original) {
    return params.diagnosticTag;
  }
  const sanitized = original.replaceAll("@", "@\u200b").replace(/```/g, "``\\`");
  return `${params.diagnosticTag}\n\n\`\`\`text\n${sanitized}\n\`\`\``;
}

export function resolveRouteSendPlan(params: {
  cfg: OpenClawConfig;
  route: unknown;
  origin?: RoutingOriginContext | null;
}): RouteSendPlan {
  const parsed = parseRouteEnvelope(params.route);
  if (parsed.ok) {
    const adapterResolved = ZULIP_ROUTING_ADAPTER.resolve({
      cfg: params.cfg,
      envelope: parsed.envelope,
    });
    if (adapterResolved.ok) {
      return {
        kind: "resolved",
        channel: "zulip",
        target: `zulip:stream:${adapterResolved.stream}`,
        threadId: parsed.envelope.project,
        envelope: parsed.envelope,
      };
    }
    const diagnostics = buildRouteEnvelopeDiagnostics({
      project: parsed.envelope.project,
      role: parsed.envelope.role,
      instance: parsed.envelope.instance,
    });
    const origin = normalizeOriginContext(params.origin);
    if (!origin) {
      return {
        kind: "error",
        payload: {
          ok: false,
          error: {
            code: "routing_origin_missing",
            dropReason: "routing_failure",
            message: "routing: origin context missing for routing fallback",
            reason: adapterResolved.reason,
            project: diagnostics.project,
            role: diagnostics.role,
            instance: diagnostics.instance,
          },
        },
      };
    }
    return {
      kind: "fallback",
      channel: "zulip",
      target: `zulip:stream:${origin.stream}`,
      threadId: origin.topic,
      reason: adapterResolved.reason,
      diagnostics,
      diagnosticTag: buildRoutingFailureTag({
        reason: adapterResolved.reason,
        diagnostics,
      }),
    };
  }

  const diagnostics = buildRouteEnvelopeDiagnostics({
    project: parsed.project,
    role: parsed.role,
    instance: parsed.instance,
  });
  const origin = normalizeOriginContext(params.origin);
  if (!origin) {
    return {
      kind: "error",
      payload: {
        ok: false,
        error: {
          code: "routing_origin_missing",
          dropReason: "routing_failure",
          message: "routing: origin context missing for routing fallback",
          reason: parsed.reason,
          project: diagnostics.project,
          role: diagnostics.role,
          instance: diagnostics.instance,
        },
      },
    };
  }
  return {
    kind: "fallback",
    channel: "zulip",
    target: `zulip:stream:${origin.stream}`,
    threadId: origin.topic,
    reason: parsed.reason,
    diagnostics,
    diagnosticTag: buildRoutingFailureTag({
      reason: parsed.reason,
      diagnostics,
    }),
  };
}
