import { drizzle, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { env } from '$env/dynamic/private';
import * as schema from './schema';

type Db = NeonHttpDatabase<typeof schema>;

let _db: Db | undefined;

function getDb(): Db {
	if (_db) return _db;
	const url = env.DATABASE_URL;
	if (!url) throw new Error('DATABASE_URL not configured');
	_db = drizzle(neon(url), { schema });
	return _db;
}

/** Lazy proxy so the Vercel build can succeed without DATABASE_URL at compile time. */
export const db = new Proxy({} as Db, {
	get(_target, prop, receiver) {
		const value = Reflect.get(getDb(), prop, receiver);
		return typeof value === 'function' ? value.bind(getDb()) : value;
	}
});
