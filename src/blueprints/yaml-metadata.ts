// ---
// relationships:
//   implements: blueprint-authoring
// ---
import type { Document } from "yaml";
import {
  documentMetadataSnapshot,
  reconcileDocumentMetadata,
} from "./yaml-document-metadata.js";
import {
  nodeMetadataSnapshot,
  reconcileNodeProperties,
} from "./yaml-node-metadata.js";

export function metadataSnapshot(document: Document): unknown {
  return {
    document: documentMetadataSnapshot(document),
    nodes: nodeMetadataSnapshot(document),
  };
}

export function reconcileMetadata(source: string, edited: Document): string {
  return reconcileDocumentMetadata(
    reconcileNodeProperties(source, edited),
    edited,
  );
}
