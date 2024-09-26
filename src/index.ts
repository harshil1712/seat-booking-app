import { DurableObject } from 'cloudflare:workers';

/**
 * Welcome to Cloudflare Workers! This is your first Durable Objects application.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your Durable Object in action
 * - Run `npm run deploy` to publish your application
 *
 * Bind resources to your worker in `wrangler.toml`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/durable-objects
 */

/** A Durable Object's behavior is defined in an exported Javascript class */
export class MyDurableObject extends DurableObject {
	sql = this.ctx.storage.sql;
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.initializeSeats();
	}

	private initializeSeats() {
		const cursor = this.sql.exec(`PRAGMA table_list`);

		// Check if a table exists.
		if ([...cursor].find((t) => t.name === 'seats')) {
			console.log('Table already exists');
			return;
		}

		this.sql.exec(`
			  CREATE TABLE IF NOT EXISTS seats (
			  seatId TEXT PRIMARY KEY,
			  occupant TEXT
			  )
			`);

		// For this demo, we populate the table with 60 seats.
		// Since SQLite in DOs is fast, we can do a query per INSERT instead of batching them in a transaction.
		for (let row = 1; row <= 10; row++) {
			for (let col = 0; col < 6; col++) {
				const seatNumber = `${row}${String.fromCharCode(65 + col)}`;
				this.sql.exec(`INSERT INTO seats VALUES (?, null)`, seatNumber);
			}
		}
	}

	// Get all seats.
	getSeats() {
		let results = [];

		// Query returns a cursor.
		let cursor = this.sql.exec(`SELECT seatId, occupant FROM seats`);

		// Cursors are iterable.
		for (let row of cursor) {
			// Each row is an object with a property for each column.
			results.push({ seatNumber: row.seatId, occupant: row.occupant });
		}

		return results;
	}

	// Assign a seat to a passenger.
	assignSeat(seatId: string, occupant: string) {
		// Check that seat isn't occupied.
		let cursor = this.sql.exec(`SELECT occupant FROM seats WHERE seatId = ?`, seatId);
		let result = [...cursor][0]; // Get the first result from the cursor.

		if (!result) {
			return { message: 'Seat not available', status: 400 };
		}
		if (result.occupant !== null) {
			return { message: 'Seat not available', status: 400 };
		}

		// If the occupant is already in a different seat, remove them.
		this.sql.exec(`UPDATE seats SET occupant = null WHERE occupant = ?`, occupant);

		// Assign the seat. Note: We don't have to worry that a concurrent request may
		// have grabbed the seat between the two queries, because the code is synchronous
		// (no `await`s) and the database is private to this Durable Object. Nothing else
		// could have changed since we checked that the seat was available earlier!
		this.sql.exec(`UPDATE seats SET occupant = ? WHERE seatId = ?`, occupant, seatId);

		// Broadcast the updated seats.
		this.broadcastSeats();
		return { message: `Seat ${seatId} booked successfully`, status: 200 };
	}

	private handleWebSocket(request: Request) {
		console.log('WebSocket connection requested');
		const [client, server] = Object.values(new WebSocketPair());

		this.ctx.acceptWebSocket(server);
		console.log('WebSocket connection established');

		return new Response(null, { status: 101, webSocket: client });
	}

	private broadcastSeats() {
		this.ctx.getWebSockets().forEach((ws) => ws.send(JSON.stringify(this.getSeats())));
	}

	async fetch(request: Request) {
		return this.handleWebSocket(request);
	}
}

export default {
	/**
	 * This is the standard fetch handler for a Cloudflare Worker
	 *
	 * @param request - The request submitted to the Worker from the client
	 * @param env - The interface to reference bindings declared in wrangler.toml
	 * @param ctx - The execution context of the Worker
	 * @returns The response to be sent back to the client
	 */
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		const flightId = url.searchParams.get('flightId');

		if (!flightId) {
			return new Response('Flight ID not found. Provide flightId in the query parameter', { status: 404 });
		}

		const id = env.MY_DURABLE_OBJECT.idFromName(flightId);
		const stub = env.MY_DURABLE_OBJECT.get(id);

		if (request.method === 'GET' && url.pathname === '/seats') {
			return new Response(JSON.stringify(await stub.getSeats()), {
				headers: { 'Content-Type': 'application/json' },
			});
		} else if (request.method === 'POST' && url.pathname === '/book-seat') {
			const { seatNumber, name } = (await request.json()) as {
				seatNumber: string;
				name: string;
			};
			const result = await stub.assignSeat(seatNumber, name);
			return new Response(JSON.stringify(result));
		} else if (request.headers.get('Upgrade') === 'websocket') {
			return stub.fetch(request);
		}

		return new Response('Not found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;
