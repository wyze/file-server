
var compressible = require('compressible')
var resolve = require('resolve-path')
var hash = require('hash-stream')
var mime = require('mime-types')
var spdy = require('@wyze/spdy-push')
var assert = require('assert')
var zlib = require('mz/zlib')
var Path = require('path')
var fs = require('mz/fs')

var extname = Path.extname
var basename = Path.basename

var methods = 'HEAD,GET,OPTIONS'
var notfound = {
  ENOENT: true,
  ENAMETOOLONG: true,
  ENOTDIR: true,
}

/**
 * Map of file extension to request type.
 * See https://fetch.spec.whatwg.org/#concept-request-type
 * See https://github.com/GoogleChrome/http2-push-manifest/blob/master/lib/manifest.js#L30
 */
var extensiontotype = {
  '.css': 'style',
  '.gif': 'image',
  '.html': 'document',
  '.png': 'image',
  '.jpg': 'image',
  '.js': 'script',
  '.json': 'script',
  '.svg': 'image',
  '.webp': 'image',
  '.woff': 'font',
  '.woff2': 'font'
};

module.exports = serve

function serve(root, options) {
  if (typeof root === 'object') {
    options = root
    root = null
  }

  options = options || {}
  root = root || options.root || process.cwd()

  var cache = Object.create(null)
  var maxage = options.maxage
  var cachecontrol = maxage != null
    ? ('public, max-age=' + (maxage / 1000 | 0))
    : ''
  var etagoptions = options.etag || {}
  var algorithm = etagoptions.algorithm || 'sha256'
  var encoding = etagoptions.encoding || 'base64'
  var index = options.index
  var hidden = options.hidden

  // get the file from cache if possible
  async function get(path) {
    var val = cache[path]
    if (val && val.compress && (await fs.exists(val.compress.path))) return val

    var stats

    try {
      stats = await fs.stat(path)
    } catch (err) {
      if (err = ignoreStatError(err)) throw err
    }
    // we don't want to cache 404s because
    // the cache object will get infinitely large
    if (!stats || !stats.isFile()) return
    stats.path = path

    var file = cache[path] = {
      stats: stats,
      etag: '"' + (await hash(path, algorithm)).toString(encoding) + '"',
      type: mime.contentType(extname(path)) || 'application/octet-stream',
    }

    if (!compressible(file.type)) return file

    // if we can compress this file, we create a .gz
    var compress = file.compress = {
      path: path + '.gz'
    }

    // delete old .gz files in case the file has been updated
    try {
      await fs.unlink(compress.path)
    } catch (err) {}

    // save to a random file name first
    var tmp = path + '.' + random() + '.gz'

    await new Promise(function (resolve, reject) {
      fs.createReadStream(path)
      .on('error', reject)
      .pipe(zlib.createGzip())
      .on('error', reject)
      .pipe(fs.createWriteStream(tmp))
      .on('error', reject)
      .on('finish', resolve)
    })

    try {
      compress.stats = await fs.stat(tmp)
    } catch (err) {
      if (err = ignoreStatError(err)) throw err
    }

    // if the gzip size is larger than the original file,
    // don't bother gzipping
    if (compress.stats.size > stats.size) {
      delete file.compress
      await fs.unlink(tmp)
    } else {
      // otherwise, rename to the correct path
      await fs.rename(tmp, compress.path)
    }

    return file
  }

  async function send(ctx) {
    var req = ctx.request
    var res = ctx.response
    var path = ctx.path

    path = path || req.path.slice(1) || ''

    // index file support
    var directory = path === '' || path.slice(-1) === '/'
    if (index && directory) path += 'index.html'

    // make path relative
    if (path.slice(0, 1) === '/') path = path.slice(1)

    // regular paths can not be absolute
    path = resolve(root, path)

    // hidden file support
    if (!hidden && leadingDot(path)) return

    var file = await get(path)
    if (!file) return // 404

    // proper method handling
    var method = req.method
    switch (method) {
      case 'HEAD':
      case 'GET':
        break // continue
      case 'OPTIONS':
        res.set('Allow', methods)
        res.status = 204
        return file
      default:
        res.set('Allow', methods)
        res.status = 405
        return file
    }

    res.status = 200
    res.etag = file.etag
    res.lastModified = file.stats.mtime
    res.type = file.type
    if (cachecontrol) res.set('Cache-Control', cachecontrol)

    if (req.fresh) {
      res.status = 304
      return file
    }

    if (method === 'HEAD') return file

    if (file.compress && req.acceptsEncodings('gzip', 'identity') === 'gzip') {
      res.set('Content-Encoding', 'gzip')
      res.length = file.compress.stats.size
      res.body = fs.createReadStream(file.compress.path)
    } else {
      res.set('Content-Encoding', 'identity')
      res.length = file.stats.size
      res.body = fs.createReadStream(path)
    }

    res.set('Vary', 'Accept-Encoding')

    return file
  }

  async function push(ctx, path, opts) {
    assert(path, 'you must define a path!')
    if (!ctx.res.isSpdy) return

    opts = opts || {}

    assert(path[0] !== '/', 'you can only push relative paths')
    var uri = path // original path

    // index file support
    var directory = path === '' || path.slice(-1) === '/'
    if (index && directory) path += 'index.html'

    // regular paths can not be absolute
    path = resolve(root, path)

    var file = await get(path)
    assert(file, 'can not push file: ' + uri)

    var options = {
      path: '/' + uri,
      priority: opts.priority,
    }

    var headers = options.headers = {
      'content-type': file.type,
      etag: file.etag,
      'last-modified': file.stats.mtime.toUTCString(),
    }

    if (cachecontrol) headers['cache-control'] = cachecontrol

    if (file.compress) {
      headers['content-encoding'] = 'gzip'
      headers['content-length'] = file.compress.stats.size
      options.filename = file.compress.path
    } else {
      headers['content-encoding'] = 'identity'
      headers['content-length'] = file.stats.size
      options.filename = path
    }

    headers['vary'] = 'Accept-Encoding'

    spdy(ctx.res)
      .push(options)
      .catch(ctx.onerror)

    return file
  }

  // middleware
  return async function serve(ctx, next) {
    // should we push?
    // needs to happen before next() so headers aren't set
    if (options.push && ctx.path === '/') {
      // Refactor
      options.files.forEach(async function(file) {
        try {
          await push(ctx, file, options.pushOptions)
        } catch (err) {
          ctx.status = err.statusCode || err.status || 500
        }
      })
    }

    // set Link headers
    if (options.link && ctx.path === '/') {
      ctx.set('Link', options.files.map(function (file) {
        var ext = file.split('.').pop()
        var type = extensiontotype['.' + ext]

        return '</' + file + '>; rel=preload; as=' + type
      }).join(', '))
    }

    await next()

    if (ctx.body != null || ctx.status != 404) return

    return await send(ctx)
  }
}

function ignoreStatError(err) {
  if (notfound[err.code]) return
  err.status = 500
  return err
}

function leadingDot(path) {
  return '.' === basename(path)[0]
}

function random() {
  return Math.random().toString(36).slice(2)
}
