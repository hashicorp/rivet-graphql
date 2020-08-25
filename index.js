let { GraphQLClient } = require('graphql-request')
const { parse, parseType } = require('graphql/language/parser')
const { print } = require('graphql/language/printer')

module.exports = function Rivet(url, options) {
  if (!options.timeout) options.timeout = 30000
  const retryCount = options.retryCount || 0
  delete options.retryCount

  const client = new GraphQLClient(url, options)

  if (retryCount) {
    client.request = requestWithRetry.bind(
      null,
      retryCount,
      client.request.bind(client)
    )
  }

  function fetch({ query, fragments = [], dependencies = [], variables }) {
    if (!query) throw fetchMissingQueryError()

    const _fragments = temporary_processFragments(fragments)
    const _dependencies = processDependencies(dependencies)
    const _query = processVariables(dependencies, variables, query)

    return client.request(
      `${_query}\n${[..._fragments, ..._dependencies].join('\n')}`,
      variables
    )
  }

  fetch.client = client

  return fetch
}

// Fragments are the simplest use case, the user must provide all fragments manually
// This is an un-ideal DX so it is deprecated.
function temporary_processFragments(fragments) {
  if (fragments.length)
    console.warn(
      '[rivet] The "fragments" argument is deprecated, please use "dependencies" instead.'
    )
  return [].concat(fragments)
}

function extractFragmentSpecs(dependencies) {
  // throw an error if dependencies isn't an array
  if (!Array.isArray(dependencies)) throw dependenciesTypeError(dependencies)

  // filter out any dependencies that don't have a fragment spec
  return dependencies
    .filter((d) => d.fragmentSpec)
    .map((d) => {
      return Object.assign({}, d.fragmentSpec, { __original: d })
    })
}

// Go through component dependencies and extract all of the fragments that we need
// to make the query. This is a recursive function to account for deep nested deps.
function processDependencies(_dependencies) {
  const dependencies = extractFragmentSpecs(_dependencies)
  return dependencies.reduce((acc, component) => {
    // Add the main fragment if one is provided
    if (component.fragment) {
      acc.push(component.fragment)
    }

    // Recursively iterate through dependencies and collect all fragments
    if (component.dependencies) {
      acc.push(...processDependencies(component.dependencies))
    }

    // Dedupe the array before returning
    return [...new Set(acc)]
  }, [])
}

// Go through components and variables and ensure that the user has provided values
// for all variables that components need. Then dynamically inject variables that
// components depend on into the main query.
function processVariables(dependencies, variables, query) {
  // First, we loop through dependencies to extract the variables they define
  // Along the way we throw clear errors if there are any variable mismatched
  const vars = _findVariables(dependencies, variables)

  // If there are no variables, we can return
  if (!Object.keys(vars).length) return query

  // Otherwise, inject those variables into the query's params.
  // First we parse the query into an AST
  const ast = parse(query)

  // See function definition below for details
  if (ast.definitions.length > 1) throw multipleQueriesError()

  // Then we loop through the variables and create AST nodes for them
  Object.entries(vars).map(([_name, _type]) => {
    const variable = {
      kind: 'Variable',
      name: { kind: 'Name', value: _name },
    }
    const type = parseType(_type)

    // Add the AST nodes to the variable definitions at the top of the query.
    // Worth noting it only does this for the first query defined in the file,
    // but we throw if there is more than one anyway.
    ast.definitions[0].variableDefinitions.push({
      kind: 'VariableDefinition',
      variable,
      type,
    })
  })

  // Finally we stringify the modified AST back into a graphql string
  return print(ast)
}

// Internal function, recursively extracts "variables" arguments from a set of components
// and its deep nested dependencies.
function _findVariables(_dependencies, variables) {
  const dependencies = extractFragmentSpecs(_dependencies)

  return dependencies.reduce((acc, component) => {
    if (component.requiredVariables) {
      // If no variables are passed to fetch but dependencies define variables, error
      if (!variables) throw variableMismatchError(component)

      Object.entries(component.requiredVariables).map(([k, v]) => {
        // If variables are present but the one we need is missing, error
        if (!variables[k]) throw variableMismatchError(component, k)
        // Otherwise, add the variable to our list
        acc[k] = v
      })
    }

    // If the component has dependencies, we recurse to get an object containing
    // any dependency variables, then add to the object. We naturally dedupe since
    // this is an object, so we just add all.
    if (component.dependencies) {
      Object.entries(_findVariables(component.dependencies, variables)).map(
        ([k, v]) => {
          acc[k] = v
        }
      )
    }

    return acc
  }, {})
}

// Super clear error messages when component dependencies ask for variables that
// are not provided in the fetch query.
function variableMismatchError(component, specificVar) {
  const fragmentName = parse(component.fragment).definitions[0].name.value
  const fragmentVars = Object.keys(component.requiredVariables).map(
    (v) => `"${v}"`
  )
  return new Error(
    `The fragment "${fragmentName}" requires ${
      specificVar
        ? `the variable "${specificVar}"`
        : `variables ${fragmentVars.join(', ')}`
    }, but it is not provided. Make sure you are passing "variables" as an argument to "fetch", and that it defines ${
      specificVar ? `"${specificVar}"` : fragmentVars.join(', ')
    }.`
  )
}

// request with retries if the query fails
async function requestWithRetry(retryCount, originalRequest, ...args) {
  const uuid = _createUUID()
  const maxRetries = retryCount
  for (let retry = 1; retry <= maxRetries; retry++) {
    try {
      return await originalRequest(...args)
    } catch (err) {
      console.log(`[${uuid}] Failed retry #${retry}, retrying...`)
      const isLastAttempt = retry === maxRetries
      if (isLastAttempt) {
        console.error(`[${uuid}] Failed all retries, throwing!`)
        throw err
      }
    }
  }
}

// used to identify a retried request
function _createUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = (Math.random() * 16) | 0,
      v = c == 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

// We error if there were multiple queries, since graphql errors both
// if a variable is present but not used, or not present and used. In theory
// we could search each query's AST to determine if/where the variable is used,
// and only add it to the correcy query, we just don't support that yet.
function multipleQueriesError() {
  return new Error(
    'You have defined multiple queries in one request and are also using variables. At the moment, we do not support the use of variables with multiple queries. Please either consolidate to one query per request, or make a PR to to add this functionalty.'
  )
}

function fetchMissingQueryError() {
  return new Error('The "query" parameter is required')
}

function dependenciesTypeError(dependencies) {
  return new Error(
    `The "dependencies" argument must be an array, the following dependency argument is not valid: ${JSON.stringify(
      dependencies
    )}`
  )
}
