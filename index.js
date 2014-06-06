
var sendfile = require('koa-sendfile')
var resolve = require('resolve-path')
var hash = require('hash-stream')
var Path = require('path')

var methods = 'HEAD,GET,OPTIONS'

module.exports = function (root, options) {
  if (typeof root === 'object') {
    options = root
    root = null
  }

  options = options || {}
  root = root || options.root || process.cwd()

  var maxage = options.maxage
  var cachecontrol = maxage != null
    ? ('public, max-age=' + (maxage / 1000 | 0))
    : ''
  var etagoptions = options.etag || {}
  var algorithm = etagoptions.algorithm || 'sha256'
  var encoding = etagoptions.encoding || 'base64'
  var index = options.index
  var hidden = options.hidden

  serve.send = send
  return serve

  function* serve(next) {
    yield* next

    // response is handled
    if (this.response.body) return
    if (this.response.status !== 404) return

    yield* send.call(this)
  }

  function* send(path) {
    path = path || this.request.path.slice(1) || ''

    // index file support
    var directory = path === '' || path.slice(-1) === '/'
    if (index && directory) path += 'index.html'

    // regular paths can not be absolute
    path = resolve(root, path)

    // hidden file support
    if (!hidden && leadingDot(path)) return

    var stats = yield* sendfile.call(this, path)
    if (!stats || !stats.isFile()) return // 404
    stats.path = path

    if (cachecontrol) this.response.set('Cache-Control', cachecontrol)

    // proper method handling
    switch (this.request.method) {
      case 'HEAD':
      case 'GET':
        break // continue
      case 'OPTIONS':
        this.response.set('Allow', methods)
        this.response.status = 204
        return stats
      default:
        this.response.set('Allow', methods)
        this.response.status = 405
        return stats
    }

    // koa-sendfile only checks last modified,
    // so we calculate the etag using crypto
    var buf = yield hash(path, algorithm)
    this.response.etag = buf.toString(encoding)
    if (this.request.fresh) this.response.status = 304

    return stats
  }
}

function leadingDot(path) {
  return '.' === Path.basename(path)[0]
}
