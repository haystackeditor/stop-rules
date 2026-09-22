import { apiBase } from "./config.js";
import { HttpError, httpGet } from "./http.js";

export interface Team {
  id: string;
  name: string;
  memberIds: string[];
}

export async function loadTeam(id: string): Promise<Team> {
  return httpGet<Team>(`${apiBase}/teams/${encodeURIComponent(id)}`);
}

export async function findTeam(id: string): Promise<Team | null> {
  try {
    return await loadTeam(id);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  }
}
