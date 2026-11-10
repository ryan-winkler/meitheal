declare module "astro:content" {
  export function getCollection(name: string): Promise<Array<{ id: string; data: Record<string, unknown> }>>;
}
