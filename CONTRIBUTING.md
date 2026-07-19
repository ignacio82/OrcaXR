# Contributing to OrcaXR

First off, thank you for considering contributing to OrcaXR! It's people like you that make the open-source 3D printing community so incredible.

## Developer Certificate of Origin (DCO)

To ensure that we maintain clear legal provenance for all code in this repository, we require all contributors to sign off on their commits using the Developer Certificate of Origin (DCO). 

You do not need to sign a complex Contributor License Agreement (CLA). By simply adding a `Signed-off-by` line to your commit messages, you assert that you have the right to submit the code under the project's license (AGPL-3.0).

Please read the full text of the DCO in the `DCO.txt` file in this repository.

### How to Sign Your Commits

Add the following line to the bottom of your commit message:

```text
Signed-off-by: Your Name <your.email@example.com>
```

You can do this easily via the Git command line using the `-s` flag:

```bash
git commit -s -m "Your commit message"
```

## How to Contribute

1.  **Reporting Bugs:** Open an issue on GitHub. Please include your browser and version, operating system or headset model, input method, and steps to reproduce the issue. If it's a slicing issue, attach the STL/3MF file and the generated G-code if possible.
2.  **Suggesting Enhancements:** Open an issue on GitHub and describe your idea. If you have UI sketches or spatial layout ideas, please include them!
3.  **Pull Requests:**
    *   Fork the repository.
    *   Create a new branch for your feature or bugfix (`git checkout -b feature/my-new-feature`).
    *   Make your changes.
    *   Commit your changes, making sure to sign off (`git commit -s -m "Add some feature"`).
    *   Push to the branch (`git push origin feature/my-new-feature`).
    *   Open a Pull Request against the `main` branch.

## Development Setup

The active application is web-native. Use Node.js 22 and npm:

```bash
npm --prefix web ci
npm --prefix web run dev
```

Before submitting a change, run the relevant focused checks and the web quality gate:

```bash
npm --prefix web run quality
```

The repository-wide clean-clone gate also installs and verifies the server and
WASM packages and requires Docker for its Compose validation:

```bash
./scripts/quality.sh
```

The deprecated native Android tree is not required for normal web development.
Read `GEMINI.md` before development as directed by `AGENTS.md`; its
Android-specific build sections apply only when working on retained native
engine history or other specialized build paths.

## License

By contributing to OrcaXR, you agree that your contributions will be licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
