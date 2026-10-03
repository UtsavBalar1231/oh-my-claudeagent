export type User = { id: number; name: string };

export const USERS: User[] = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, name: `user-${i + 1}` }));

export function handleList(_request: Request): Response {
  return Response.json(USERS);
}
