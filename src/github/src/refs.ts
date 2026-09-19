import { GitHubError } from "./transport/errors.js";

export type NodeId = string & { readonly __brand: "NodeId" };
export type ProjectId = NodeId & { readonly __kind: "project" };
export type ItemId = NodeId & { readonly __kind: "item" };
export type FieldId = NodeId & { readonly __kind: "field" };

/** Brands a string the caller obtained from GitHub as a node id. */
export function nodeId(id: string): NodeId {
  return id as NodeId;
}

export type IsoDate = `${number}-${number}-${number}`;

export type RepoRef = `${string}/${string}` | { owner: string; repo: string };
export type IssueRef =
  `${string}/${string}#${number}` | { owner: string; repo: string; number: number };

export interface RepoCoordinates {
  owner: string;
  repo: string;
}

export interface IssueCoordinates extends RepoCoordinates {
  number: number;
}

const repoPattern = /^([^/\s#]+)\/([^/\s#]+)$/;
const issuePattern = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/;

export function parseRepoRef(ref: RepoRef): RepoCoordinates {
  if (typeof ref !== "string") return { owner: ref.owner, repo: ref.repo };
  const match = repoPattern.exec(ref);
  if (!match) throw new GitHubError("VALIDATION", `invalid repository reference: ${ref}`);
  return { owner: match[1]!, repo: match[2]! };
}

export function parseIssueRef(ref: IssueRef): IssueCoordinates {
  if (typeof ref !== "string") return { owner: ref.owner, repo: ref.repo, number: ref.number };
  const match = issuePattern.exec(ref);
  if (!match) throw new GitHubError("VALIDATION", `invalid issue reference: ${ref}`);
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
}

export function formatRepoRef(coords: RepoCoordinates): `${string}/${string}` {
  return `${coords.owner}/${coords.repo}`;
}

export function formatIssueRef(coords: IssueCoordinates): `${string}/${string}#${number}` {
  return `${coords.owner}/${coords.repo}#${coords.number}`;
}

/** Cache scope keys. One place decides how scopes are spelled. */
export const scopes = {
  labels: (r: RepoCoordinates) => `labels:${formatRepoRef(r)}`,
  milestones: (r: RepoCoordinates) => `milestones:${formatRepoRef(r)}`,
  issueTypes: (owner: string) => `issue-types:${owner}`,
  issueFields: (owner: string) => `issue-fields:${owner}`,
  projectFields: (projectId: string) => `project-fields:${projectId}`,
  actors: (owner: string) => `actors:${owner}`,
  owners: () => "owners",
  repos: () => "repos",
  issues: (r: RepoCoordinates) => `issues:${formatRepoRef(r)}`,
};
