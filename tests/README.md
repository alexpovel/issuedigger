# Tests

Where we are going, we don't need tests.

Kidding aside, this project is almost impossible to test:

- few opportunities for unit tests (everything's a network call)
- [Cloudflare Vectorize](https://developers.cloudflare.com/vectorize/) bindings are not
  available for [local development with
  `wrangler`](https://developers.cloudflare.com/workers/wrangler/commands/#dev) yet:

  > ▲ [WARNING] Vectorize bindings are not currently supported in local mode. Please use --remote if you are working with them.

  but switching to `wrangler dev --remote` yields:

  > ▲ [WARNING] Queues are currently in Beta and are not supported in wrangler dev remote mode.

  due to [Cloudflare Queues'](https://developers.cloudflare.com/queues/) beta status.

  These limitations disallow for effective local development, and means the application
  only ever runs in production 🤷‍♀️ But you know what they say: *everyone tests in
  production, it's just that some people also test beforehand*.
