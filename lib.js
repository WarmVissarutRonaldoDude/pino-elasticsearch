'use strict'

/* eslint no-prototype-builtins: 0 */
const AWS = require('aws-sdk')
const pump = require('pump')
const split = require('split2')
const Writable = require('readable-stream').Writable
const { Client } = require('elasticsearch')
const Parse = require('fast-json-parse')
const toEcs = require('pino-to-ecs')

function pinoElasticSearch (opts) {
  const splitter = split(function (line) {
    var parsed = new Parse(line)
    if (parsed.err) {
      this.emit('unknown', line, parsed.err)
      return
    }
    var value = parsed.value
    if (typeof value === 'boolean') {
      this.emit('unknown', line, 'Boolean value ignored')
      return
    }
    if (value === null) {
      this.emit('unknown', line, 'Null value ignored')
      return
    }
    if (typeof value !== 'object') {
      value = {
        data: value,
        time: setDateTimeString(value)
      }
    } else {
      value.time = setDateTimeString(value)
    }

    function setDateTimeString (value) {
      if (typeof value === 'object' && value.hasOwnProperty('time')) {
        if (
          (typeof value.time === 'string' && value.time.length) ||
          (typeof value.time === 'number' && value.time >= 0)
        ) {
          return new Date(value.time).toISOString()
        }
      }
      return new Date().toISOString()
    }
    return value
  })

  if (opts.isAWS) {
    AWS.config.update({
      credentials: new AWS.Credentials(process.env.AWS_ACCESS_KEY, process.env.AWS_SECRET),
      region: process.env.AWS_REGION
    })
  }

  const ecsClientAwsOptions = opts.isAWS ? {
    connectionClass: require('http-aws-es')
  } : {}

  const esClientOptions = Object.assign({
    hosts: [opts.node]
  }, ecsClientAwsOptions)

  const client = new Client(esClientOptions)

  const esVersion = Number(opts['es-version']) || 7
  const useEcs = !!opts.ecs
  const index = opts.index || 'pino'
  const buildIndexName = typeof index === 'function' ? index : null
  const type = opts.type || 'log'

  const writable = new Writable({
    objectMode: true,
    highWaterMark: opts['bulk-size'] || 500,
    writev: function (chunks, cb) {
      const docs = new Array(chunks.length * 2)
      for (var i = 0; i < docs.length; i++) {
        if (i % 2 === 0) {
          // add the header
          docs[i] = {
            index: {
              // from Elasticsearch v8 and above, types will be removed
              // while in Elasticsearch v7 types are deprecated
              _type: esVersion >= 7 ? undefined : type,
              _index: getIndexName(chunks[Math.floor(i / 2)].chunk.time)
            }
          }
        } else {
          // add the chunk
          if (useEcs) {
            docs[i] = toEcs(chunks[Math.floor(i / 2)].chunk)
          } else {
            docs[i] = chunks[Math.floor(i / 2)].chunk
          }
        }
      }
      client.bulk({
        body: docs
      }, function (err, result) {
        if (!err) {
          const items = result.items
          for (var i = 0; i < items.length; i++) {
            // depending on the Elasticsearch version, the bulk response might
            // contain fields 'create' or 'index' (> ES 5.x)
            const create = items[i].index || items[i].create
            splitter.emit('insert', create, docs[i * 2 + 1])
          }
        } else {
          splitter.emit('insertError', err)
        }
        // skip error and continue
        cb()
      })
    },
    write: function (body, enc, cb) {
      var idx = getIndexName(body.time)
      // from Elasticsearch v8 and above, types will be removed
      // while in Elasticsearch v7 types are deprecated
      const obj = {
        index: idx,
        type: esVersion >= 7 ? undefined : type,
        body: useEcs ? toEcs(body) : body
      }
      client.index(obj, function (err, data) {
        if (!err) {
          splitter.emit('insert', data.result, obj.body)
        } else {
          console.log('ERR ', err)
          splitter.emit('insertError', err)
        }
        // skip error and continue
        cb()
      })
    }
  })

  pump(splitter, writable)

  return splitter

  function getIndexName (time) {
    if (buildIndexName) {
      return buildIndexName(time)
    }
    return index.replace('%{DATE}', time.substring(0, 10))
  }
}

module.exports = pinoElasticSearch
