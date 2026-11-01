# Great Kingdom practice · GitHub Pages

Live practice app: https://philipontheroof.github.io/great-kingdom-practice/

This repository hosts the prebuilt, static practice app from `dist/`; immutable ONNX files live in `model-files/` outside the Pages artifact. GitHub Actions only validates and uploads the committed files; it does not install the project, build the app, run Python, or contact the local training installation.

The app and ONNX model run in each visitor's browser using WebGPU or WASM. Pages serves the HTML, JavaScript, runtime files and model manifests. The browser downloads only its selected model from an exact commit-pinned raw.githubusercontent.com URL in this repository and checks its SHA-256. Visitors need a network connection to open the site and obtain assets. Analysis runs on-device after those files load. The site does not provide a Python/HTTP inference server, private model delivery, or a promise of fully offline startup. User-created studies stay in that browser's local storage unless the user exports them.

## Create and publish the repository

1. Create a new **empty public repository** on GitHub. Do not initialize it with a README, license, or `.gitignore`. Public Pages hosting does not depend on a private-repository plan.
2. This folder contains the verified `dist/` bundle (UI, manifests, WASM and `.nojekyll`) plus `model-files/`. Keep the manifest model commit URLs intact.
3. From this directory, set the remote to the new repository and publish the files:

   ```sh
   ./publish.sh https://github.com/OWNER/REPOSITORY.git
   ```

4. In the GitHub repository, open **Settings → Pages** and choose **GitHub Actions** under **Build and deployment → Source**. The workflow has no pull-request trigger; it deploys pushes to `main`, and manual runs are restricted to `main`.
5. Wait for the `Deploy static practice site` workflow to complete. Its deployment job publishes the URL in the `github-pages` environment.

The Actions workflow is buildless: it checks the bundle, uploads `dist/`, then deploys it. The background publisher converts new evaluation snapshots, validates them, and pushes the new model and catalog to `main`; app changes also require a validated static build and push; a public visitor never needs the Mac's Python environment or training database.

## Bundle limits and verification

GitHub's published Pages site limit is 1 GiB, and a Git repository file cannot exceed 100 MiB. The workflow enforces both and applies the stricter 25 MiB target to each `.onnx` file so the public model stays a normal Git file without Git LFS. It also checks local index assets, rejects root-relative index URLs, and verifies each ONNX SHA both against the repository file and the exact ancestor commit blob pinned by its manifest. ONNX files stay outside the Pages artifact, keeping its size independent of the model count.

The workflow deliberately uploads only `dist/`, so repository notes and workflow files are not published as website content. The model and static runtime are public downloads and should contain no credentials or private training data.

The workflow also verifies every model/runtime asset SHA against its manifest before deployment. `publish.sh` adds only the prepared deployment files, never a parent workspace. Published on 2026-11-02 at the URL above. GitHub Pages uses the included Actions workflow. The catalog now contains the current training run's evaluation snapshots, named by generation (4세대 through 224세대 at the initial catch-up). The newest generation is first. An independent publisher watches future committed four-generation evaluation snapshots; it does not alter learning or NAS/Gitea LFS archiving. The deployed bundle and on-device WebGPU analysis were verified on a Mac browser; iPad/iPhone behavior remains to be checked.
