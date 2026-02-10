import { Gauge, Counter } from 'prom-client'

/**
 * Prometheus metrics for object metadata cache
 * Used to monitor cache effectiveness for COG/geospatial workloads
 */

export const ObjectCacheSizeGauge = new Gauge({
  name: 'storage_object_metadata_cache_size',
  help: 'Number of objects currently cached in memory',
  labelNames: ['region'],
})

export const ObjectCacheHitsCounter = new Counter({
  name: 'storage_object_metadata_cache_hits_total',
  help: 'Total number of cache hits (avoided DB queries)',
  labelNames: ['region'],
})

export const ObjectCacheMissesCounter = new Counter({
  name: 'storage_object_metadata_cache_misses_total',
  help: 'Total number of cache misses (required DB queries)',
  labelNames: ['region'],
})

export const ObjectCacheEvictionsCounter = new Counter({
  name: 'storage_object_metadata_cache_evictions_total',
  help: 'Total number of cache evictions (LRU or size-based)',
  labelNames: ['region'],
})

export const ObjectCacheHitRateGauge = new Gauge({
  name: 'storage_object_metadata_cache_hit_rate',
  help: 'Cache hit rate (hits / total requests)',
  labelNames: ['region'],
})
