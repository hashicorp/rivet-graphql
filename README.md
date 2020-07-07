<img src='https://p176.p0.n0.cdn.getcloudapp.com/items/mXu7GOBx/rivert-logo.svg?v=3113465ffbe401a4918b80694db76467' width='300' />

A small, light, [relay-like](https://relay.dev) library for data fetching. Relies on strong conventions in which components define their data needs.

Rivet was built for and works best in a system in which you fetch all of your data **at the page level**, preferably in a single query, then pass down the data as needed to the components that use it. Below we'll take a tour of a sample implementation of Rivet within a React app, from bottom to top. We'll start with a small, simple component, move up to a larger, more complex component that uses the simple component as a dependency, then finally to a page that implements the more complex component. We'll start with the simple component, `Button`:

```jsx
import fragment from './fragment.graphql'

function Button({ title, url }) {
  return <a href={url}>{title}</a>
}

Button.fragmentSpec = { fragment }

export default Button
```

And here's `fragment.graphql`, assuming that this setup uses a raw string loader for graphql files. This is not required and the graphql query can be used directly as a string within the component, but colocating allows for nice separation of concerns and better syntax highlighting.

```graphql
fragment buttonFields on Button {
  title
  url
}
```

The only unusual thing here is the fact that `Button` also defines a property called `fragmentSpec`. This property is an object, in this case with the key `fragment` set to be equal to the contents of the graphql file above. This allows higher levels to be aware of what data the button component needs, and ensure that it is properly fetched.

> **NOTE**: As a matter of convention, we like to name all component fragments `<componentName>Fields`. So, for example if you have a component called "Button", its fragment would be named `buttonFields`. For a component named "Docs Sidenav", its fragment would be `docsSidenavFields`. By keeping our naming consistent, it makes it easy for our team to write queries and debug errors.

Let's move on to the next component.

```jsx
import fragment from './fragment.graphql'
import Button from '../button'

function PersonAndButton({ person, button }) {
  return (
    <>
      <p>Check out this cool person: {JSON.stringify(person)}</p>
      <Button {...button} />
    </>
  )
}

PersonAndButton.fragmentSpec = {
  fragment,
  dependencies: [Button],
  requiredVariables: { name: 'String!' },
}

export default PersonAndButton
```

And its fragment file:

```graphql
fragment personAndButtonFields on PersonAndButton {
  person: people(filter: { eq: $name }) {
    id
  }
  button {
    ...buttonFields
  }
}
```

This component is a bit more complex. Notice that it uses the `Button` component internally, and within the graphql file, uses the `buttonFields` fragment to fetch the data that the `Button` component wants. In order to ensure that this fragment is available, `Button` is declared as a dependency within the fragment spec, under `dependencies`. This is where the magic happens. When this fragment spec is used to fetch data, the system will go through the components in the fragment spec, and ensure that their fragments are also imported so that they are available for use.

Additionally, we need a variable to filter down a list of people to just one person, which can be seen in the graphql file. In order to ensure that this variable is available to us, we add its name and type to `requiredVariables`.

Let's put it all together by moving up to the page level where the query is made. First, we define the configuration for rivet in a separate file so it can easily be shared between multiple components:

```js
import rivet from 'rivet-graphql'

export default rivet('https://graphql.yourapi.com', {
  /* options */
})
```

This library uses [graphql-request](https://github.com/prisma-labs/graphql-request) under the hood for configuration -- see the docs for graphql-request for more info on which additional options can be passed in. This library additionally defaults the `timeout` option to 30 seconds.

Now let's look at a page, where we make our base level query. We will show an example using [nextjs](https://nextjs.org/) here. It's worth noting that Rivet is not coupled to nextjs, the `rivetQuery` function simply returns a promise which can be handled in any manner that's needed.

```jsx
import rivetQuery from '../rivet-config'
import query from './query.graphql'
import PersonAndButton from '../components/person-and-button'

export default SomePage({ title, personAndButtonData }) {
  return (<>
    <h1>{title}</h1>
    <PersonAndButton {...personAndButtonData} />
  </>)
}

export async function getStaticProps() {
  const result = await rivetQuery({
    query,
    dependencies: [PersonAndButton],
    variables: { name: 'Hingle McCringleberry' }
  })
  return { props: { ...result } }
}
```

and our `query.graphql` file:

```graphql
query SomePage {
  title
  personAndButtonData {
    ...personAndButtonFields
  }
}
```

So here's where we make the request. We pull down `fetch` and run it within `getStaticProps`. Let's break down the arguments it takes:

- `query` _(String, required)_ - the primary graphql query for the page
- `dependencies` _(Array, optional)_ - if you are using components on the page that require data, you should import each component and pass it in here to ensure all the component's data is fetched properly.
- `variables` _(Object, optional)_ - if your query needs variables, they can be **defined** here as an object, with the variable name as the key and the variable value as the value.

Note that this is in many ways very _similar_ to the `fragmentSpec`s we defined in components, but different in a few specific ways. First, we define a query rather than a fragment, since this is where we make the request. `dependencies` works exactly the same way. Within the query, we can take advantage of all the dependencies we passed to `dependencies` using `<componentName>Fields`, as can be seen in the example above. And rather than `variableRequirements`, here we have `variables`, where we define the actual values for the variables.

It's worth noting that despite using a variable in `PersonAndButton`, and defining a variable for `fetch`, our query above does not contain any indication of variable usage. Luckily, `fetch` takes care of automatically deduping and adding all the variable logic needed for component dependencies to our query before sending it off. The only time you need to add your own variable logic to a query is if you are using variables inside the query itself. If the variable is used within another component, all that's needed is to provide the value to `fetch` and make sure its defined in that component's fragment spec under `requiredVariables`.

### Using the Raw Client

If you want to use Rivet to just fire off a normal graphql request, you can do that too. `rivetQuery.client` is an instantiated [graphql-request](https://github.com/prisma-labs/graphql-request) client which can be used as you would typically do.
