# PlanSurf Budget

Static budget planner frontend. The shared [PlanSurf Service](https://github.com/beawart/plansurf.service) handles authentication and reads/writes budget data in the private `beawart/plansurf-data` repository.

The frontend uses `https://plansurf-service.onrender.com` and the service's budget routes. It keeps the returned session token in memory; the GitHub token and service configuration belong only in the service deployment, not this repository.

To deploy the frontend, publish the repository root with GitHub Pages (`main`, `/ (root)`). The service allows the `https://beawart.github.io` origin. For local testing, serve the page over HTTP and add that exact origin to the service's `CORS_ORIGINS` setting. `file://` is not supported.

Open the cloud control in the app, enter the budget app password configured on the service, sign in, then choose **Pull latest** or **Save local data**. See the service repository for deployment, environment, and API details.
