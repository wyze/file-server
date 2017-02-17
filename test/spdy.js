
var Koa = require('koa')
var path = require('path')
var assert = require('assert')
var https = require('https')
var spdy = require('spdy')

var staticServer = require('..')

describe('spdy push', function () {
  it('should push a file', async function () {
    var res = await request('index.js')
    res.path.should.equal('/index.js')
    res.headers['content-type'].should.match(/application\/javascript/)
    res.headers['content-encoding'].should.equal('gzip')
    res.headers['content-length'].should.be.ok
    res.headers['etag'].should.be.ok
    res.headers['last-modified'].should.be.ok
  })

  it('should not gzip small files', async function () {
    var res = await request('test/index.html')
    res.path.should.equal('/test/index.html')
    res.headers['content-type'].should.match(/text\/html/)
    res.headers['content-encoding'].should.equal('identity')
    res.headers['content-length'].should.be.ok
    res.headers['etag'].should.be.ok
    res.headers['last-modified'].should.be.ok
  })

  it('should normalize file paths', async function () {
    var res = await request('/index.js')
    res.path.should.equal('/index.js')
  })

  it.skip('should throw on unknown files', async function () {
    var res = await request('asdfasdf')
    res.statusCode.should.equal(500)
  })

  it('should read from manifest', async function () {
    var res = await request('', path.resolve('test/push_manifest.json'))
    res.path.should.equalOneOf(['/test/index.html', '/test/file-server.js'])
  })
})

async function request(path, manifest) {
  var app = new Koa()
  app.use(staticServer({
    push: true,
    files: path && [path],
    manifest: manifest
  }))
  app.use(function(ctx) {
    ctx.response.status = 204
  })

  var server = spdy.createServer(require('spdy-keys'), app.callback())

  server.listen()

  var res
  // note: agent may throw errors!
  var agent = spdy.createAgent({
    host: '127.0.0.1',
    port: server.address().port,
    rejectUnauthorized: false,
  })

  var req = https.request({
    agent: agent,
    path: '/',
  })

  // we need to add a listener to the `push` event
  // otherwise the agent will just destroy all the push streams
  var streams = []
  app.on('push', function (opts) {
    if (res) res.emit('push', opts)
    streams.push(opts)
  })

  res = await new Promise(function (resolve, reject) {
    req.once('response', resolve)
    req.once('error', reject)
    req.end()
  })

  res.streams = streams
  res.agent = agent

  if (res.statusCode === 204) {
    if (!res.streams.length) {
      await new Promise(function (resolve) {
        res.once('push', resolve)
      })
    }

    return res.streams[0]
  }

  return res
}
