import { HttpError, httpGet } from "./http.js";

const API = "https://api.example.com";

export interface Team {
  id: string;
  name: string;
  memberIds: string[];
}

export async function loadTeam(id: string): Promise<Team> {
  return httpGet<Team>(`${API}/teams/${encodeURIComponent(id)}`);
}

export async function findTeam(id: string): Promise<Team | null> {
  try {
    return await loadTeam(id);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  }
}
