/**
 * Room network topologies.
 * - P2P_MESH: every peer dials every other peer directly (best latency, O(n^2) connections).
 * - P2P_STAR: every peer dials only the elected host, which relays state (scales better, adds a hop).
 */
export const ConnectionType = Object.freeze({
  P2P_MESH: 'p2p-mesh',
  P2P_STAR: 'p2p-star',
});
