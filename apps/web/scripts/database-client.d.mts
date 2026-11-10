import type { Client } from "@libsql/client"

export function openDatabase(url: string): Client
