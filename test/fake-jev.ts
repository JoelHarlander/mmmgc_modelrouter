/**
 * A local stand-in for TypeSafe's System One endpoint.
 *
 * The live paths — `JevClient.ask`, the `live` classifier, the Jev judge, `--record` —
 * had never been executed by anything, offline or otherwise. `src/jev.ts` is the one
 * file in `src/` that talks to a network, and its retry, error and cost-extraction
 * branches had no coverage at all.
 *
 * This serves the real wire shape from `127.0.0.1`, so those paths run end to end with
 * no credential, no network beyond loopback, and no spend. It is a test fixture, not a
 * simulator: it answers whatever the scenario tells it to.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { JevQuestion } from "../src/jev.ts";

export interface FakeJevRequest {
	path: string;
	authorization?: string;
	body: { state: unknown; model: string; questions: Record<string, JevQuestion> };
}

export type FakeJevHandler = (request: FakeJevRequest, callIndex: number) => { status: number; body: unknown; headers?: Record<string, string> };

export interface FakeJev {
	baseUrl: string;
	requests: FakeJevRequest[];
	close: () => Promise<void>;
}

/** A well-formed answer for the router's three questions. */
export function routingAnswer(tier: "light" | "standard" | "heavy", confidence: number, extras: { tools?: number; stakes?: number } = {}) {
	const others = (["light", "standard", "heavy"] as const).filter((t) => t !== tier);
	const rest = (1 - confidence) / others.length;
	return {
		model: "jev-latest",
		answers: {
			tier: {
				type: "choice",
				choice: tier,
				confidence,
				probabilities: { [tier]: confidence, ...Object.fromEntries(others.map((t) => [t, rest])) },
			},
			needs_tools: { type: "noul", noul: extras.tools ?? 0.9 },
			stakes: { type: "score", score: extras.stakes ?? 1.2, confidence: 0.8, legend: {}, probabilities: {} },
		},
		usage: { input_tokens: 450, output_tokens: 0 },
	};
}

/** A well-formed answer for the fan-out judge's single `best` question. */
export function judgeAnswer(choice: string, confidence: number, labels: string[]) {
	const rest = (1 - confidence) / Math.max(1, labels.length - 1);
	return {
		model: "jev-latest",
		answers: {
			best: {
				type: "choice",
				choice,
				confidence,
				probabilities: Object.fromEntries(labels.map((l) => [l, l === choice ? confidence : rest])),
			},
		},
		usage: { input_tokens: 900, output_tokens: 0 },
	};
}

export async function startFakeJev(handler: FakeJevHandler): Promise<FakeJev> {
	const requests: FakeJevRequest[] = [];
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			let body: FakeJevRequest["body"];
			try {
				body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as FakeJevRequest["body"];
			} catch {
				res.writeHead(400).end('{"error":{"type":"bad_request","message":"not json"}}');
				return;
			}
			const request: FakeJevRequest = { path: req.url ?? "", authorization: req.headers.authorization, body };
			requests.push(request);
			const reply = handler(request, requests.length - 1);
			res.writeHead(reply.status, { "content-type": "application/json", ...(reply.headers ?? {}) });
			res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		requests,
		close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
	};
}
