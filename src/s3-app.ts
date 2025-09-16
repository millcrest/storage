import fastify, { FastifyInstance, FastifyServerOptions } from 'fastify'
import { routes, schemas, plugins, setErrorHandler } from './http'
import { getConfig } from './config'

const { keepAliveTimeout, headersTimeout } = getConfig()

const buildS3 = (opts: FastifyServerOptions = {}): FastifyInstance => {
  const app = fastify(opts)

  app.addContentTypeParser('*', function (request, payload, done) {
    done(null)
  })

  app.server.keepAliveTimeout = keepAliveTimeout * 1000
  app.server.headersTimeout = headersTimeout * 1000

  // Add common schemas
  app.addSchema(schemas.authSchema)
  app.addSchema(schemas.errorSchema)

  // Register only essential plugins for S3
  app.register(plugins.signals)
  app.register(plugins.tenantId)
  app.register(plugins.tracing)
  app.register(plugins.logRequest({ excludeUrls: ['/status'] }))

  // Register S3 routes WITHOUT prefix
  app.register(routes.s3)

  setErrorHandler(app)

  app.get('/status', async (request, response) => response.status(200).send())

  return app
}

export default buildS3
