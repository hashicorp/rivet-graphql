/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

const rewire = require('rewire')
const rivet = rewire('./')
const http = require('http')
const { promisify } = require('util')

test('custom fetch function with single fragment', () => {
  const query = 'test query'
  const fragments = 'test fragment'
  return testFetchMock(
    { query, fragments, variables: { foo: 'bar' } },
    (queryResult, vars) => {
      expect(queryResult).toBe(`${query}\n${fragments}`)
      expect(vars.foo).toBe('bar')
    }
  )
})

test('custom fetch function with multiple fragments', () => {
  const query = 'test query'
  const fragments = ['f1', 'f2', 'f3']
  return testFetchMock(
    { query, fragments, variables: { foo: 'bar' } },
    (queryResult, vars) => {
      expect(queryResult).toBe(`${query}\n${fragments.join('\n')}`)
      expect(vars.foo).toBe('bar')
    }
  )
})

test('allows dependencies with no fragment defined', () => {
  const query = 'query Foo { alert { wow } }'
  const deps = [
    {
      fragmentSpec: {
        dependencies: [
          { fragmentSpec: { fragment: 'fragment test on Test { test }' } },
        ],
      },
    },
  ]
  testFetchMock({ query, dependencies: deps }, (queryResult) => {
    expect(queryResult).toBe(`query Foo { alert { wow } }
fragment test on Test { test }`)
  })
})

test('handles "components" parameter errors', () => {
  const query = 'query Foo { alert { wow } }'
  const dependencies = [
    {
      fragmentSpec: {
        fragment: 'fragment c1 on Test { test }',
        requiredVariables: { productId: 'ItemId!', other: 'String!' },
      },
    },
  ]

  expect(() => testFetchMock({ query, dependencies }, () => {})).toThrow(
    'The fragment "c1" requires variables "productId", "other", but it is not provided. Make sure you are passing "variables" as an argument to "fetch", and that it defines "productId", "other".'
  )
  expect(() =>
    testFetchMock({ query, dependencies, variables: { foo: 'bar' } }, () => {})
  ).toThrow(
    'The fragment "c1" requires the variable "productId", but it is not provided. Make sure you are passing "variables" as an argument to "fetch", and that it defines "productId".'
  )
  expect(() => testFetchMock({ dependencies })).toThrow(
    'The "query" parameter is required'
  )
  expect(() =>
    testFetchMock({
      query: 'foo',
      dependencies: {
        fragmentSpec: {
          requiredVariables: { productId: 'ItemId!', other: 'String!' },
        },
      },
    })
  ).toThrow(
    'The "dependencies" argument must be an array, the following dependency argument is not valid: {"fragmentSpec":{"requiredVariables":{"productId":"ItemId!","other":"String!"}}}'
  )
})

test("skips any components that don't have a fragmentSpec property", async () => {
  const query = 'query Foo { alert { wow } }'

  const d1 = function Test() {}
  d1.fragmentSpec = {
    fragment: 'fragment d1 on Test { test }',
  }

  const d2 = function Test2() {}

  return testFetchMock({ query, dependencies: [d1, d2] }, (queryResult) => {
    expect(queryResult).toBe(`query Foo { alert { wow } }
fragment d1 on Test { test }`)
  })
})

test('handles the "components" parameter correctly', async () => {
  const query = 'query Foo { alert { wow } }'

  const d1 = function Test() {}
  d1.fragmentSpec = {
    fragment: 'fragment d1 on Test { test }',
    requiredVariables: { other: 'String!', foo: 'Bar' },
  }

  class d2 {}
  d2.fragmentSpec = {
    fragment: 'fragment d2 on Test { test }',
  }

  function d3() {}
  d3.fragmentSpec = {
    fragment: 'fragment d3 on Test { test }',
    dependencies: [d4],
  }

  function d4() {}
  d4.fragmentSpec = {
    fragment: 'fragment d4 on Test { test }',
    requiredVariables: { levelThree: 'Wow' },
  }

  const deps = [d1, d2, d3]

  const dependencies = [
    {
      fragmentSpec: {
        fragment: 'fragment c1 on Test { test }',
        dependencies: [deps[0], deps[1]],
      },
    },
    {
      fragmentSpec: {
        fragment: 'fragment c2 on Test { test }',
        dependencies: [deps[2]],
        requiredVariables: { productId: 'ItemId!', other: 'String!' },
      },
    },
    {
      fragmentSpec: {
        fragment: 'fragment c3 on Test { test }',
        dependencies: [deps[0]],
        requiredVariables: { other: 'String!', doge: 'Wow' },
      },
    },
  ]

  return testFetchMock(
    {
      query,
      dependencies,
      variables: {
        productId: 'test',
        other: 'test',
        doge: 'test',
        foo: 'test',
        levelThree: 'test',
      },
    },
    (queryResult) => {
      const expectedQuery = `query Foo($other: String!, $foo: Bar, $productId: ItemId!, $levelThree: Wow, $doge: Wow) {
  alert {
    wow
  }
}

fragment c1 on Test { test }
fragment d1 on Test { test }
fragment d2 on Test { test }
fragment c2 on Test { test }
fragment d3 on Test { test }
fragment d4 on Test { test }
fragment c3 on Test { test }`
      expect(queryResult).toBe(expectedQuery)
    }
  )
})

test('handles fetch errors with style and grace', () => {
  return createTestInstance()({
    query: 'query Foo { alert { wow } }',
  }).catch((err) =>
    expect(err.response.errors[0].message).toBe(
      "Field 'wow' doesn't exist on type 'AlertRecord'"
    )
  )
})

test('times out infinitely hanging requests', () => {
  // let's make a hanging api route
  const server = http
    .createServer((_, res) => setTimeout(40000, () => res.end('hello world')))
    .listen(1234)

  // and now we test it
  return rivet('http://localhost:1234', { timeout: 1000 })({
    query: 'test',
  })
    .catch((err) => {
      expect(err.toString()).toBe(
        'FetchError: network timeout at: http://localhost:1234/'
      )
    })
    .finally(() => promisify(server.close.bind(server))())
})

test('retries queries if they fail', () => {
  let failCount = 2
  const server = createTestGraphqlServer('test', failCount)

  // and now we test it
  return rivet('http://localhost:1234', { retryCount: failCount + 1 })({
    query: 'query Foo { alert { wow } }',
  })
    .then((res) => {
      expect(res).toEqual('test')
    })
    .finally(() => promisify(server.close.bind(server))())
})

test('still throws if all retries fail', () => {
  let failCount = 2
  const server = createTestGraphqlServer('test', failCount)

  // and now we test it
  return rivet('http://localhost:1234', { retryCount: failCount })({
    query: 'test',
  })
    .catch((err) => {
      expect(err.toString()).toEqual(
        'Error: GraphQL Error (Code: 500): {"response":{"data":"test","status":500},"request":{"query":"test\\n"}}'
      )
    })
    .finally(() => promisify(server.close.bind(server))())
})

test('standalone request with retries', () => {
  let failCount = 2
  const server = createTestGraphqlServer('test', failCount)

  const r = rivet('http://localhost:1234', { retryCount: failCount + 1 })
  return r.client
    .request('test')
    .then((res) => {
      expect(res).toEqual('test')
    })
    .finally(() => promisify(server.close.bind(server))())
})

function createTestGraphqlServer(returnValue, failCount = 0) {
  return http
    .createServer((_, res) => {
      if (failCount-- > 0) res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ data: returnValue }))
    })
    .listen(1234)
}

function createTestInstance(options) {
  return rivet(
    'https://graphql.datocms.com',
    Object.assign(
      {
        headers: { Authorization: '78d2968c99a076419fbb' },
        cors: true,
      },
      options
    )
  )
}

function testFetchMock(params, cb) {
  class MockGraphQLClient {
    request(...args) {
      cb(...args)
      return Promise.resolve()
    }
  }

  rivet.__with__(
    'GraphQLClient',
    MockGraphQLClient
  )(() => {
    return createTestInstance()(params)
  })
}
