
var Koa = require('koa')
var path = require('path')
var assert = require('assert')
var https = require('https')
var spdy = require('spdy')

var staticServer = require('..')

describe('spdy push', function () {
  it.skip('should push a file', async function () {
    var stream = await request('index.js')
    stream.url.should.equal('/index.js')
    stream.headers['content-type'].should.match(/application\/javascript/)
    stream.headers['content-encoding'].should.equal('gzip')
    stream.headers['content-length'].should.be.ok
    stream.headers['etag'].should.be.ok
    stream.headers['last-modified'].should.be.ok
  })

  it.skip('should not gzip small files', async function () {
    var stream = await request('test/index.html')
    stream.url.should.equal('/test/index.html')
    stream.headers['content-type'].should.match(/text\/html/)
    stream.headers['content-encoding'].should.equal('identity')
    stream.headers['content-length'].should.be.ok
    stream.headers['etag'].should.be.ok
    stream.headers['last-modified'].should.be.ok
  })

  it('should throw on / files', async function () {
    var res = await request('/index.js')
    res.statusCode.should.equal(500)
  })

  it.skip('should throw on unknown files', async function () {
    var res = await request('asdfasdf')
    res.statusCode.should.equal(500)
  })
})

async function request(path) {
  var app = new Koa()
  app.use(staticServer({
    push: true,
    files: [path]
  }))
  app.use(function(ctx) {
    ctx.response.status = 204
  })

  var server = spdy.createServer(require('spdy-keys'), app.callback())

  await new Promise(function (resolve) {
    server.listen(resolve)
  })

  var res
  var agent = spdy.createAgent({
    host: '127.0.0.1',
    port: server.address().port,
    rejectUnauthorized: false,
  })
  // note: agent may throw errors!

  var req = https.request({
    host: '127.0.0.1',
    agent: agent,
    method: 'GET',
    path: '/',
  })

  // we need to add a listener to the `push` event
  // otherwise the agent will just destroy all the push streams
  var streams = []
  req.on('push', function (stream) {
    if (res) res.emit('push', stream)
    streams.push(stream)
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
