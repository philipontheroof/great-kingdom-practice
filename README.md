# Great Kingdom practice · GitHub Pages

This repository hosts the prebuilt, static practice app from `dist/`. GitHub Actions only validates and uploads the committed files; it does not install the project, build the app, run Python, or contact the local training installation.

The app and ONNX model run in each visitor's browser using WebGPU or WASM. Pages serves the HTML, JavaScript, runtime files, and public model file. Visitors need a network connection to open the site and obtain assets. Analysis runs on-device after those files load. The site does not provide a Python/HTTP inference server, private model delivery, or a promise of fully offline startup. User-created studies stay in that browser's local storage unless the user exports them.

## Create and publish the repository

1. Create a new **empty public repository** on GitHub. Do not initialize it with a README, license, or `.gitignore`. Public Pages hosting does not depend on a private-repository plan.
2. This prepared folder already contains the complete verified `dist/` bundle, including the model, WASM files and `.nojekyll`. Keep its relative paths intact.
3. From this directory, set the remote to the new repository and publish the files:

   ```sh
   ./publish.sh https://github.com/OWNER/REPOSITORY.git
   ```

4. In the GitHub repository, open **Settings → Pages** and choose **GitHub Actions** under **Build and deployment → Source**. The workflow has no pull-request trigger; it deploys pushes to `main`, and manual runs are restricted to `main`.
5. Wait for the `Deploy static practice site` workflow to complete. Its deployment job publishes the URL in the `github-pages` environment.

The Actions workflow is buildless: it checks the bundle, uploads `dist/`, then deploys it. Updating the model or app means preparing and validating a new static bundle on the development Mac, committing that bundle, and pushing to `main`; a public visitor never needs the Mac's Python environment or training database.

## Bundle limits and verification

GitHub's published Pages site limit is 1 GiB, and a Git repository file cannot exceed 100 MiB. The workflow enforces both and applies the stricter 25 MiB target to each `.onnx` file so the public model stays a normal Git file without Git LFS. It also checks that index assets exist locally, rejects root-relative index URLs that break project-site paths, requires at least one ONNX model, and blocks common training/runtime files from `dist/`.

The workflow deliberately uploads only `dist/`, so repository notes and workflow files are not published as website content. The model and static runtime are public downloads and should contain no credentials or private training data.

The workflow also verifies every model/runtime asset SHA against its manifest before deployment. `publish.sh` adds only the prepared deployment files, never a parent workspace. The current connected GitHub account is `philipontheroof`; creating the empty repository requires signing in or granting a repository-creation capability. This package does not claim that a GitHub repository or Pages URL is already live.
