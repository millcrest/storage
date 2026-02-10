import Agent, { HttpsAgent } from 'agentkeepalive'
import {
  HttpPoolErrorGauge,
  HttpPoolFreeSocketsGauge,
  HttpPoolPendingRequestsGauge,
  HttpPoolSocketsGauge,
} from '@internal/monitoring/metrics'
import { getConfig } from '../../config'

const { region } = getConfig()

export interface InstrumentedAgent {
  httpAgent: Agent
  httpsAgent: HttpsAgent
  monitor: () => NodeJS.Timeout | undefined
  close: () => void
}

export interface AgentStats {
  busySocketCount: number
  freeSocketCount: number
  pendingRequestCount: number
  errorSocketCount: number
  timeoutSocketCount: number
  createSocketErrorCount: number
}

/**
 * Creates an instrumented agent
 * Adding prometheus metrics to the agent
 * Optimized for COG/range request workloads with:
 * - Longer socket reuse timeout (60s instead of 15s) for burst patterns
 * - Faster keep-alive probes (100ms) to detect stale connections
 * - FIFO scheduling for better handling of concurrent burst requests
 * - Increased free socket pool to reduce connection overhead
 */
export function createAgent(name: string, options: { maxSockets: number }): InstrumentedAgent {
  const agentOptions = {
    maxSockets: options.maxSockets,
    keepAlive: true,
    // Faster keep-alive probes to quickly reuse connections during burst COG tile requests
    keepAliveMsecs: 200,
    // Hold sockets longer (60s) to handle COG workloads where GDAL makes many requests in bursts
    // then pauses, avoiding constant reconnection overhead
    freeSocketTimeout: 1000 * 60,
    // Increase free socket pool to avoid connection churn during concurrent range requests
    maxFreeSockets: Math.floor(options.maxSockets * 0.25),
    // Use FIFO scheduling for better handling of burst request patterns (vs LIFO default)
    scheduling: 'fifo' as const,
    // Timeout for socket creation (prevents hanging on connection issues)
    timeout: 30000,
  }

  const httpAgent = new Agent(agentOptions)
  const httpsAgent = new HttpsAgent(agentOptions)
  let watcher: NodeJS.Timeout | undefined = undefined

  return {
    httpAgent,
    httpsAgent,
    monitor: () => {
      const agent = watchAgent(name, 'https', httpsAgent)
      watcher = agent
      return agent
    },
    close: () => {
      if (watcher) {
        clearInterval(watcher)
      }
    },
  }
}

/**
 * Metrics
 *
 * HttpPoolSockets
 * HttpPoolFreeSockets
 * HttpPoolPendingRequests
 * HttpPoolError
 *
 * @param name
 * @param protocol
 * @param stats
 */
function updateHttpAgentMetrics(name: string, protocol: string, stats: AgentStats) {
  // Update the metrics with calculated values
  HttpPoolSocketsGauge.set({ name, region, protocol }, stats.busySocketCount)
  HttpPoolFreeSocketsGauge.set({ name, region, protocol }, stats.freeSocketCount)
  HttpPoolPendingRequestsGauge.set({ name, region }, stats.pendingRequestCount)
  HttpPoolErrorGauge.set({ name, region, type: 'socket_error', protocol }, stats.errorSocketCount)
  HttpPoolErrorGauge.set(
    { name, region, type: 'timeout_socket_error', protocol },
    stats.timeoutSocketCount
  )
  HttpPoolErrorGauge.set(
    { name, region, type: 'create_socket_error', protocol },
    stats.createSocketErrorCount
  )
}

export function watchAgent(name: string, protocol: 'http' | 'https', agent: Agent | HttpsAgent) {
  return setInterval(() => {
    const httpStatus = agent.getCurrentStatus()

    const httpStats = gatherHttpAgentStats(httpStatus)

    updateHttpAgentMetrics(name, protocol, httpStats)
  }, 5000)
}

// Function to update Prometheus metrics based on the current status of the agent
export function gatherHttpAgentStats(status: Agent.AgentStatus) {
  // Calculate the number of busy sockets by iterating over the `sockets` object
  let busySocketCount = 0
  for (const host in status.sockets) {
    if (status.sockets.hasOwnProperty(host)) {
      busySocketCount += status.sockets[host]
    }
  }

  // Calculate the number of free sockets by iterating over the `freeSockets` object
  let freeSocketCount = 0
  for (const host in status.freeSockets) {
    if (status.freeSockets.hasOwnProperty(host)) {
      freeSocketCount += status.freeSockets[host]
    }
  }

  // Calculate the number of pending requests by iterating over the `requests` object
  let pendingRequestCount = 0
  for (const host in status.requests) {
    if (status.requests.hasOwnProperty(host)) {
      pendingRequestCount += status.requests[host]
    }
  }

  return {
    busySocketCount,
    freeSocketCount,
    pendingRequestCount,
    errorSocketCount: status.errorSocketCount,
    timeoutSocketCount: status.timeoutSocketCount,
    createSocketErrorCount: status.createSocketErrorCount,
  }
}
