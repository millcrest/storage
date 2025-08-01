import crypto from 'crypto'
import { ERRORS } from '@internal/errors'

interface SignatureV4Options {
  enforceRegion: boolean
  allowForwardedHeader?: boolean
  nonCanonicalForwardedHost?: string
  credentials: Omit<Credentials, 'shortDate'> & { secretKey: string }
}

export interface ClientSignature {
  credentials: Credentials
  signature: string
  signedHeaders: string[]
  sessionToken?: string
  longDate: string
  contentSha?: string
  policy?: {
    raw: string
    value: Policy
  }
}

interface SignatureRequest {
  url: string
  body?: string | ReadableStream | Buffer
  headers: Record<string, string | string[]>
  method: string
  query?: Record<string, string>
  prefix?: string
}

interface Credentials {
  accessKey: string
  shortDate: string
  region: string
  service: string
}

export interface Policy {
  expiration: string
  conditions: PolicyConditions
}

interface PolicyConditions {
  policies: PolicyEntry[]
  contentLengthRange: {
    min: number
    max: number
    valid: boolean
  }
}

interface PolicyEntry {
  operator: string
  key: string
  value: string
}

/**
 * Lists the headers that should never be included in the
 * request signature signature process.
 */
export const ALWAYS_UNSIGNABLE_HEADERS = {
  authorization: true,
  connection: true,
  expect: true,
  from: true,
  'keep-alive': true,
  'max-forwards': true,
  pragma: true,
  referer: true,
  te: true,
  trailer: true,
  'transfer-encoding': true,
  upgrade: true,
  'user-agent': true,
  'x-amzn-trace-id': true,
}

export const ALWAYS_UNSIGNABLE_QUERY_PARAMS = {
  'X-Amz-Signature': true,
}

export class SignatureV4 {
  public readonly serverCredentials: SignatureV4Options['credentials']
  enforceRegion: boolean
  allowForwardedHeader?: boolean
  nonCanonicalForwardedHost?: string

  constructor(options: SignatureV4Options) {
    this.serverCredentials = options.credentials
    this.enforceRegion = options.enforceRegion
    this.allowForwardedHeader = options.allowForwardedHeader
    this.nonCanonicalForwardedHost = options.nonCanonicalForwardedHost
  }

  static parseAuthorizationHeader(headers: Record<string, any>) {
    const clientSignature = headers.authorization
    if (typeof clientSignature !== 'string') {
      throw ERRORS.InvalidSignature('Missing authorization header')
    }

    const parts = clientSignature.split(' ')
    if (parts[0] !== 'AWS4-HMAC-SHA256') {
      throw ERRORS.InvalidSignature('Unsupported authorization type')
    }

    const params = this.extractClientSignature(clientSignature)
    const credentialPart = params.get('Credential')
    const signedHeadersPart = params.get('SignedHeaders')
    const signature = params.get('Signature')
    const longDate = headers['x-amz-date']
    const contentSha = headers['x-amz-content-sha256']
    const sessionToken = headers['x-amz-security-token']

    if (!validateTypeOfStrings(credentialPart, signedHeadersPart, signature, longDate)) {
      throw ERRORS.InvalidSignature('Invalid signature format')
    }

    const signedHeaders = signedHeadersPart?.split(';') || []
    const credentialsPart = credentialPart?.split('/') || []

    if (credentialsPart.length !== 5) {
      throw ERRORS.InvalidSignature('Invalid credentials')
    }

    const [accessKey, shortDate, region, service] = credentialsPart
    return {
      credentials: { accessKey, shortDate, region, service },
      signedHeaders,
      signature: signature as string,
      longDate,
      contentSha,
      sessionToken,
    }
  }

  static isChunkedUpload(headers: Record<string, any>): boolean {
    const sha = headers['x-amz-content-sha256']
    if (typeof sha !== 'string') return false
    // If it exactly matches or starts with streaming prefix...
    return (
      sha.startsWith('STREAMING-AWS4-HMAC-SHA256-PAYLOAD') ||
      sha.startsWith('STREAMING-UNSIGNED-PAYLOAD')
    )
  }

  static parseQuerySignature(query: Record<string, any>) {
    const credentialPart = query['X-Amz-Credential']
    const signedHeaders: string = query['X-Amz-SignedHeaders']
    const signature: string = query['X-Amz-Signature']
    const longDate: string = query['X-Amz-Date']
    const contentSha: string = query['X-Amz-Content-Sha256']
    const sessionToken: string | undefined = query['X-Amz-Security-Token']
    const expires = query['X-Amz-Expires']

    if (!validateTypeOfStrings(credentialPart, signedHeaders, signature, longDate)) {
      throw ERRORS.InvalidSignature('Invalid signature format')
    }

    if (expires) {
      this.checkExpiration(longDate, expires)
    }

    const credentialsPart = credentialPart.split('/') as string[]
    if (credentialsPart.length !== 5) {
      throw ERRORS.InvalidSignature('Invalid credentials')
    }

    const [accessKey, shortDate, region, service] = credentialsPart
    return {
      credentials: { accessKey, shortDate, region, service },
      signedHeaders: signedHeaders.split(';'),
      signature,
      longDate,
      contentSha,
      sessionToken,
    }
  }

  static parseMultipartSignature(form: FormData) {
    const credentialPart = form.get('X-Amz-Credential') as string
    const signature = form.get('X-Amz-Signature') as string
    const longDate = form.get('X-Amz-Date') as string
    const contentSha = form.get('X-Amz-Content-Sha256') as string
    const sessionToken = form.get('X-Amz-Security-Token') as string
    const policy = form.get('Policy') as string

    if (!validateTypeOfStrings(credentialPart, signature, policy, longDate)) {
      throw ERRORS.InvalidSignature('Invalid signature format')
    }

    const xPolicy: Policy = JSON.parse(Buffer.from(policy, 'base64').toString('utf-8'))

    if (xPolicy.expiration) {
      this.checkExpiration(longDate, xPolicy.expiration)
    }

    const credentialsPart = credentialPart.split('/') as string[]
    if (credentialsPart.length !== 5) {
      throw ERRORS.InvalidSignature('Invalid credentials')
    }

    const [accessKey, shortDate, region, service] = credentialsPart
    return {
      credentials: { accessKey, shortDate, region, service },
      signedHeaders: [],
      signature,
      longDate,
      contentSha,
      sessionToken,
      policy: {
        raw: policy,
        value: xPolicy,
      },
    }
  }

  protected static checkExpiration(longDate: string, expires: string) {
    const expiresSec = parseInt(expires, 10)
    if (isNaN(expiresSec) || expiresSec < 0) {
      throw ERRORS.InvalidSignature('Invalid expiration')
    }

    const isoLongDate = longDate.replace(
      /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
      '$1-$2-$3T$4:$5:$6Z'
    )
    const requestDate = new Date(isoLongDate)
    const expirationDate = new Date(requestDate.getTime() + expiresSec * 1000)
    const isExpired = expirationDate < new Date()

    if (isExpired) {
      throw ERRORS.ExpiredSignature()
    }
  }

  protected static extractClientSignature(clientSignature: string) {
    return clientSignature
      .replace('AWS4-HMAC-SHA256 ', '')
      .split(',')
      .reduce((values, value) => {
        const [k, v] = value.split('=')
        values.set(k.trim(), v)
        return values
      }, new Map<string, string>())
  }

  /**
   * Verify if client signature and server signature matches
   * @param clientSignature
   * @param request
   */
  verify(clientSignature: ClientSignature, request: SignatureRequest) {
    if (typeof clientSignature.policy?.raw === 'string') {
      return this.verifyPostPolicySignature(clientSignature, clientSignature.policy.raw)
    }

    const serverSignature = this.sign(clientSignature, request)
    return crypto.timingSafeEqual(
      Buffer.from(clientSignature.signature),
      Buffer.from(serverSignature.signature)
    )
  }

  /**
   * Verifies signature for POST upload requests
   * @param clientSignature
   * @param policy
   */
  verifyPostPolicySignature(clientSignature: ClientSignature, policy: string) {
    const serverSignature = this.signPostPolicy(clientSignature, policy)
    return crypto.timingSafeEqual(
      Buffer.from(clientSignature.signature),
      Buffer.from(serverSignature)
    )
  }

  public validateChunkSignature(
    clientSignature: ClientSignature,
    chunkHash: string,
    chunkSignature: string,
    prevSignature: string = clientSignature.signature
  ): boolean {
    const { secretKey } = this.serverCredentials
    const { shortDate, region, service } = clientSignature.credentials
    const signingKey = this.signingKey(secretKey, shortDate, region, service)

    const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

    // Build the “String to Sign” for this chunk exactly per AWS:
    //    AWS4-HMAC-SHA256-PAYLOAD
    //    <longDate>
    //    <shortDate/region/service/aws4_request>
    //    <prevSignature>
    //    SHA256("")   ← the hash of the empty string
    //    SHA256(chunkData)
    const scope = `${shortDate}/${region}/${service}/aws4_request`
    const stringToSign = [
      'AWS4-HMAC-SHA256-PAYLOAD',
      clientSignature.longDate,
      scope,
      prevSignature,
      emptyHash,
      chunkHash,
    ].join('\n')

    // 4) HMAC it with the derived key and compare
    const expected = this.hmac(signingKey, stringToSign)

    return crypto.timingSafeEqual(expected, Buffer.from(chunkSignature, 'hex'))
  }

  signPostPolicy(clientSignature: ClientSignature, policy: string) {
    const serverCredentials = this.serverCredentials

    this.validateCredentials(clientSignature.credentials)
    const selectedRegion = this.getSelectedRegion(clientSignature.credentials.region)

    const signingKey = this.signingKey(
      serverCredentials.secretKey,
      clientSignature.credentials.shortDate,
      selectedRegion,
      serverCredentials.service
    )

    return this.hmac(signingKey, policy).toString('hex')
  }

  /**
   * Sign the server side signature
   * @param clientSignature
   * @param request
   */
  sign(clientSignature: ClientSignature, request: SignatureRequest) {
    const serverCredentials = this.serverCredentials

    this.validateCredentials(clientSignature.credentials)

    const longDate = clientSignature.longDate
    if (!longDate) {
      throw ERRORS.AccessDenied('No date provided')
    }

    const selectedRegion = this.getSelectedRegion(clientSignature.credentials.region)
    const canonicalRequest = this.constructCanonicalRequest(
      clientSignature,
      request,
      clientSignature.signedHeaders
    )
    const stringToSign = this.constructStringToSign(
      longDate,
      clientSignature.credentials.shortDate,
      selectedRegion,
      serverCredentials.service,
      canonicalRequest
    )
    const signingKey = this.signingKey(
      serverCredentials.secretKey,
      clientSignature.credentials.shortDate,
      selectedRegion,
      serverCredentials.service
    )

    return { signature: this.hmac(signingKey, stringToSign).toString('hex'), canonicalRequest }
  }

  protected getPayloadHash(clientSignature: ClientSignature, request: SignatureRequest) {
    const body = request.body

    // For presigned URLs and GET requests, use UNSIGNED-PAYLOAD
    if (request.query && request.query['X-Amz-Signature'] && request.method === 'GET') {
      return 'UNSIGNED-PAYLOAD'
    }

    // If contentSha is provided, use it
    if (clientSignature.contentSha) {
      return clientSignature.contentSha
    }

    // If the body is undefined, use the hash of an empty string
    if (body == undefined) {
      return 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    }

    // Calculate the SHA256 hash of the body
    if (typeof body === 'string' || ArrayBuffer.isView(body)) {
      return crypto
        .createHash('sha256')
        .update(typeof body === 'string' ? body : Buffer.from(body.buffer))
        .digest('hex')
    }

    // Default to UNSIGNED-PAYLOAD if body is not a string or ArrayBuffer
    return 'UNSIGNED-PAYLOAD'
  }

  protected constructCanonicalRequest(
    clientSignature: ClientSignature,
    request: SignatureRequest,
    signedHeaders: string[]
  ) {
    const method = request.method
    const xForwardedUri = this.getHeader(request, 'x-forwarded-uri')
    const canonicalUri =
      xForwardedUri ??
      new URL(`http://localhost:8080${request.prefix || ''}${request.url}`).pathname

    const canonicalQueryString = this.constructCanonicalQueryString(request.query || {})
    const canonicalHeaders = this.constructCanonicalHeaders(request, signedHeaders)
    const signedHeadersString = signedHeaders.sort().join(';')
    const payloadHash = this.getPayloadHash(clientSignature, request)

    return `${method}\n${canonicalUri}\n${canonicalQueryString}\n${canonicalHeaders}\n${signedHeadersString}\n${payloadHash}`
  }

  protected constructCanonicalQueryString(query: Record<string, string>) {
    return Object.keys(query)
      .filter((key) => !(key in ALWAYS_UNSIGNABLE_QUERY_PARAMS))
      .sort()
      .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(query[key] as string)}`)
      .join('&')
  }

  protected constructCanonicalHeaders(request: SignatureRequest, signedHeaders: string[]) {
    return (
      signedHeaders
        .filter(
          (header) =>
            request.headers[header] !== undefined &&
            !(header.toLowerCase() in ALWAYS_UNSIGNABLE_HEADERS)
        )
        .sort()
        .map((header) => {
          if (header === 'host') {
            return this.getHostHeader(request)
          }

          if (header === 'content-length') {
            const headerValue = this.getHeader(request, header) ?? '0'
            return `${header}:${headerValue}`
          }

          // cloudflare modifies accept-encoding header which causes signing to fail
          // instead use x-original-accept-encoding if available
          if (header === 'accept-encoding') {
            const originalEncoding = this.getHeader(request, 'x-original-accept-encoding')
            if (originalEncoding) {
              return `${header}:${originalEncoding}`
            }
          }

          return `${header}:${this.getHeader(request, header)}`
        })
        .join('\n') + '\n'
    )
  }

  protected getHostHeader(request: SignatureRequest) {
    if (this.allowForwardedHeader) {
      const forwarded = this.getHeader(request, 'forwarded')
      if (forwarded) {
        const extractedHost = /host="?([^";]+)/.exec(forwarded)?.[1]
        if (extractedHost) {
          return `host:${extractedHost.toLowerCase()}`
        }
      }
    }

    if (this.nonCanonicalForwardedHost) {
      const xForwardedHost = this.getHeader(request, this.nonCanonicalForwardedHost.toLowerCase())
      if (xForwardedHost) {
        return `host:${xForwardedHost.toLowerCase()}`
      }
    }

    const xForwardedHost = this.getHeader(request, 'x-forwarded-host')
    if (xForwardedHost) {
      return `host:${xForwardedHost.toLowerCase()}`
      // TODO something always sets 'x-forwarded-port' to internal port, so we can't use it
      /* const port = this.getHeader(request, 'x-forwarded-port')
      const host = `host:${xForwardedHost.toLowerCase()}`

      if (port && !['443', '80'].includes(port)) {
        if (!xForwardedHost.includes(':')) {
          return host + ':' + port
        } else {
          return 'host:' + xForwardedHost.replace(/:\d+$/, `:${port}`)
        }
      }
      return host */
    }

    return `host:${this.getHeader(request, 'host')}`
  }

  protected validateCredentials(credentials: Credentials) {
    if (credentials.accessKey !== this.serverCredentials.accessKey) {
      throw ERRORS.AccessDenied('Invalid Access Key')
    }

    if (this.enforceRegion && credentials.region !== this.serverCredentials.region) {
      throw ERRORS.AccessDenied('Invalid Region')
    }

    if (credentials.service !== this.serverCredentials.service) {
      throw ERRORS.AccessDenied('Invalid Service')
    }
  }

  protected getSelectedRegion(clientRegion: string) {
    if (
      !this.enforceRegion &&
      ['auto', 'us-east-1', this.serverCredentials.region, ''].includes(clientRegion)
    ) {
      return clientRegion
    }
    return this.serverCredentials.region
  }

  protected constructStringToSign(
    date: string,
    dateStamp: string,
    region: string,
    service: string,
    canonicalRequest: string
  ) {
    const algorithm = 'AWS4-HMAC-SHA256'
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`
    const hashedCanonicalRequest = crypto
      .createHash('sha256')
      .update(canonicalRequest)
      .digest('hex')

    return `${algorithm}\n${date}\n${credentialScope}\n${hashedCanonicalRequest}`
  }

  protected signingKey(
    key: string,
    dateStamp: string,
    regionName: string,
    serviceName: string
  ): Buffer {
    const kDate = this.hmac(`AWS4${key}`, dateStamp)
    const kRegion = this.hmac(kDate, regionName)
    const kService = this.hmac(kRegion, serviceName)
    return this.hmac(kService, 'aws4_request')
  }

  protected hmac(key: string | Buffer, data: string): Buffer {
    return crypto.createHmac('sha256', key).update(data).digest()
  }

  protected getHeader(request: SignatureRequest, name: string) {
    const item = request.headers[name]
    if (Array.isArray(item)) {
      return item.join(',')
    }
    return item
  }
}

function validateTypeOfStrings(...values: any[]) {
  return values.every((value) => typeof value === 'string')
}
