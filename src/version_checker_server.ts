import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fetch from 'node-fetch'; // Using node-fetch for compatibility
import fs from 'fs/promises';
import path from 'path';
import semver from 'semver';

// --- Constants and Configuration ---

// CRITICAL SECURITY: Assume the server runs in the root of the user's project for project:// access via stdio.
// For remote servers (HTTP), this approach is UNSAFE without strict sandboxing and authentication.
const PROJECT_BASE_DIR = process.cwd();
console.log(`INFO: Using project base directory: ${PROJECT_BASE_DIR}`);

// GitHub API Token (Optional but Recommended for Rate Limits)
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (GITHUB_TOKEN) {
    console.log("INFO: Using GITHUB_TOKEN environment variable for GitHub API requests.");
} else {
    console.warn("WARN: GITHUB_TOKEN environment variable not set. GitHub API requests will be rate-limited.");
}

// Hypothetical compatibility map - requires maintenance or a better data source.
const expoCompatMap: Record<string, Record<string, string>> = {
  "49.0.0": { "react-native": "0.72.6", "react": "18.2.0" },
  "50.0.0": { "react-native": "0.73.4", "react": "18.2.0" },
  "51.0.0": { "react-native": "0.74.1", "react": "18.2.0" }, // Example future version
  // Add more SDK versions and their dependencies here
};

// --- Helper Types ---
interface GitHubRelease {
    tag_name: string;
    name: string | null;
    body: string | null;
    html_url: string;
    published_at: string | null;
}

// --- Helper Functions ---

// Extract GitHub Repo URL from NPM Data (Unchanged)
function getGitHubRepoUrl(npmData: any): string | null {
    if (!npmData || !npmData.repository) return null;
    let repoUrl = npmData.repository.url || npmData.repository;
    if (typeof repoUrl !== 'string') return null;
    repoUrl = repoUrl.replace(/^git\+/, '').replace(/\.git$/, '');
    if (repoUrl.startsWith('github:')) {
        repoUrl = `https://github.com/${repoUrl.substring(7)}`;
    }
    if (repoUrl.includes('github.com')) {
        try {
            const url = new URL(repoUrl);
            if (url.hostname === 'github.com') {
                return url.href;
            }
        } catch (e) {
            console.error(`Error parsing repository URL ${repoUrl}:`, e);
            return null;
        }
    }
    return null;
}

// Parse Owner/Repo from GitHub URL
function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
    try {
        const parsed = new URL(url);
        if (parsed.hostname === 'github.com') {
            const parts = parsed.pathname.split('/').filter(Boolean);
            if (parts.length >= 2) {
                return { owner: parts[0], repo: parts[1] };
            }
        }
    } catch (e) {
        console.error(`Error parsing GitHub URL ${url}:`, e);
    }
    return null;
}


// Fetch Releases from GitHub API
async function fetchGitHubReleases(owner: string, repo: string, perPage = 30): Promise<GitHubRelease[]> {
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=${perPage}`;
    console.log(`[Helper] Fetching GitHub releases: ${apiUrl}`);
    const headers: Record<string, string> = {
        'Accept': 'application/vnd.github.v3+json',
        'X-GitHub-Api-Version': '2022-11-28'
    };
    if (GITHUB_TOKEN) {
        headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
    }

    try {
        const response = await fetch(apiUrl, { headers });
        if (!response.ok) {
            throw new Error(`GitHub API error (${response.status}): ${response.statusText} for ${apiUrl}`);
        }
        const releases = await response.json() as GitHubRelease[];
        console.log(`[Helper] Fetched ${releases.length} releases for ${owner}/${repo}`);
        // Basic validation and cleaning of tag names
        return releases.filter(r => r.tag_name).map(r => ({
            ...r,
            tag_name: r.tag_name.replace(/^v/, '') // Remove leading 'v' from tags for semver comparison
        }));
    } catch (error: any) {
        console.error(`[Helper Error] Failed to fetch releases for ${owner}/${repo}:`, error);
        throw error; // Re-throw to be caught by the caller
    }
}

// Fetch Package Info (Helper for Tools) - Internal use, not an MCP resource itself
async function fetchPackageInfo(packageName: string, version?: string): Promise<any | null> {
     const url = version
      ? `https://registry.npmjs.org/${packageName}/${version}`
      : `https://registry.npmjs.org/${packageName}/latest`;
    console.log(`[Helper] Fetching NPM info: ${url}`);
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`NPM registry error: ${response.status} ${response.statusText}`);
      return await response.json() as any;
    } catch (error) {
      console.error(`[Helper Error] fetchPackageInfo for ${packageName}${version ? `/${version}` : ''}:`, error);
      return null;
    }
}


// --- MCP Server Setup ---

const server = new McpServer({
  name: "ReactNativeExpoHelper",
  version: "1.2.0", // Incremented version for feature completion
  description: "Provides resources, tools, and prompts to assist with React Native/Expo development, focusing on version compatibility, changelogs, and project analysis.",
});

// --- Resources ---

// 1. Package Information Resource (Updated to use helper)
server.resource(
  "npm-package-info",
  new ResourceTemplate("package://npm/{packageName}/version/{version}", { list: "package://npm/{packageName}" }), // version is optional
  "Fetches details (version, description, repo) for an NPM package, optionally for a specific version.",
  async (uri, { packageName, version }) => {
    try {
      const data = await fetchPackageInfo(packageName, version);
      if (!data) throw new Error("Failed to fetch package info from NPM.");

      // Extract relevant fields
      const relevantData = {
        name: data.name,
        version: data.version,
        description: data.description,
        homepage: data.homepage,
        repositoryUrl: getGitHubRepoUrl(data),
        npmUrl: `https://www.npmjs.com/package/${packageName}${version ? `/v/${version}` : ''}`
      };

      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify(relevantData, null, 2)
        }]
      };
    } catch (error: any) {
       console.error(`[Resource Error] npm-package-info for ${packageName}${version ? `/${version}` : ''}:`, error);
       return { contents: [{ uri: uri.href, text: `Error fetching package info for ${packageName}: ${error.message}` }] };
    }
  }
);


// 2. Changelog Resource (Implemented via GitHub API)
server.resource(
  "github-changelog",
  new ResourceTemplate("changelog://github/{owner}/{repo}", { list: undefined }),
  "Fetches recent release notes from GitHub Releases for a repository.",
  async (uri, { owner, repo }) => {
    console.log(`[Resource] Fetching GitHub changelog for ${owner}/${repo}`);
    try {
      const releases = await fetchGitHubReleases(owner, repo, 15); // Fetch recent 15 releases
      if (!releases || releases.length === 0) {
        return { contents: [{ uri: uri.href, text: `No releases found for ${owner}/${repo} via GitHub API.` }] };
      }

      // Format the releases into markdown-like text
      const formattedReleases = releases.map(r =>
        `## [${r.tag_name}](${r.html_url}) (${r.published_at ? new Date(r.published_at).toLocaleDateString() : 'N/A'})${r.name ? ` - ${r.name}` : ''}\n\n${r.body || '*No release body provided.*'}`
      ).join('

---

');

      return { contents: [{ uri: uri.href, text: formattedReleases }] };
    } catch (error: any) {
       console.error(`[Resource Error] github-changelog for ${owner}/${repo}:`, error);
       return { contents: [{ uri: uri.href, text: `Error fetching GitHub releases for ${owner}/${repo}: ${error.message}` }] };
    }
  }
);


// 3. Expo SDK Compatibility Resource (Unchanged)
server.resource(
  "expo-sdk-compatibility",
  new ResourceTemplate("compatibility://expo/sdk/{sdkVersion}", { list: undefined }),
  "Retrieves known compatible versions for a given Expo SDK version (based on internal map).",
  async (uri, { sdkVersion }) => {
    console.log(`[Resource] Checking compatibility map for Expo SDK: ${sdkVersion}`);
    const cleanVersion = semver.coerce(sdkVersion)?.version ?? sdkVersion;
    let compatInfo = expoCompatMap[cleanVersion] ?? null;
    if (!compatInfo && semver.valid(cleanVersion)) {
        const majorVersionKey = `${semver.major(cleanVersion)}.0.0`;
        compatInfo = expoCompatMap[majorVersionKey] ?? null;
        if (compatInfo) {
            console.log(`[Resource] Found compatibility info for major version ${majorVersionKey}`);
        }
    }
    const text = compatInfo
      ? `Compatibility for Expo SDK ${sdkVersion} (using data for ${Object.keys(expoCompatMap).find(k => expoCompatMap[k] === compatInfo)}):\n${JSON.stringify(compatInfo, null, 2)}`
      : `Compatibility info not found for Expo SDK ${sdkVersion}. Check official Expo documentation.`;
    return {
      contents: [{
        uri: uri.href,
        text: text
      }]
    };
  }
);

// 4. Project File Resource (Unchanged - Use with caution!)
server.resource(
  "project-file",
  new ResourceTemplate("project://{filePath}", { list: undefined }),
  "Reads a file from the project directory. SECURITY: Ensure server runs with appropriate permissions.",
  async (uri, { filePath }) => {
    const requestedPath = path.normalize(filePath);
    const absolutePath = path.resolve(PROJECT_BASE_DIR, requestedPath);
    console.log(`[Resource] Attempting to read project file: ${absolutePath}`);
    if (!absolutePath.startsWith(PROJECT_BASE_DIR + path.sep) && absolutePath !== PROJECT_BASE_DIR) {
       console.error(`[Resource Security Denied] Path traversal attempt: ${filePath} resolved to ${absolutePath}, outside of ${PROJECT_BASE_DIR}`);
       return { contents: [{ uri: uri.href, text: `Error: Access denied. Path is outside the project directory.` }] };
    }
    try {
      const content = await fs.readFile(absolutePath, 'utf-8');
      console.log(`[Resource] Successfully read file: ${absolutePath}`);
      return { contents: [{ uri: uri.href, text: content }] };
    } catch (error: any) {
      console.error(`[Resource Error] Error reading file ${absolutePath}:`, error);
      if (error.code === 'ENOENT') {
         return { contents: [{ uri: uri.href, text: `Error reading file: ${filePath} not found.` }] };
      }
      return { contents: [{ uri: uri.href, text: `Error reading file ${filePath}.` }] };
    }
  }
);


// --- Tools ---

// 1. Check Project Compatibility Tool (Unchanged)
const checkProjectCompatibilitySchema = z.object({
    packageJsonContent: z.string().describe("The content of the project's package.json file."),
    lockfileContent: z.string().optional().describe("The content of package-lock.json or yarn.lock (optional, improves accuracy)."),
    expoSdkVersion: z.string().optional().describe("Specific Expo SDK version to check against (optional, will try to infer from package.json).")
});

server.tool(
  "checkProjectCompatibility",
  checkProjectCompatibilitySchema,
  "Analyzes package.json (and optionally lockfile) against known Expo SDK compatibility data.",
  async ({ packageJsonContent, lockfileContent, expoSdkVersion }) => {
    console.log(`[Tool] Running checkProjectCompatibility...`);
    try {
      const pkg = JSON.parse(packageJsonContent);
      const dependencies = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      let versionToCheck = expoSdkVersion;
      if (!versionToCheck) {
          const detectedExpo = dependencies.expo;
          if (detectedExpo) {
              versionToCheck = semver.minVersion(detectedExpo)?.version;
              console.log(`[Tool] Inferred Expo SDK version from package.json: ${versionToCheck}`);
          }
      }
      if (!versionToCheck) {
         return { content: [{ type: "text", text: "Could not determine Expo SDK version to check compatibility against. Please specify expoSdkVersion or ensure 'expo' is in dependencies." }], isError: true };
      }
      const cleanVersion = semver.coerce(versionToCheck)?.version ?? versionToCheck;
      let compatInfo = expoCompatMap[cleanVersion] ?? null;
       if (!compatInfo && semver.valid(cleanVersion)) {
          const majorVersionKey = `${semver.major(cleanVersion)}.0.0`;
          compatInfo = expoCompatMap[majorVersionKey] ?? null;
      }
      if (!compatInfo) {
         return { content: [{ type: "text", text: `No compatibility data found in internal map for Expo SDK ${versionToCheck}. Check official Expo documentation.` }] };
      }
      const issues: string[] = [];
      const compatKeyVersion = Object.keys(expoCompatMap).find(k => expoCompatMap[k] === compatInfo);
      console.log(`[Tool] Comparing against compatibility data for Expo SDK ${compatKeyVersion}`);
      for (const [lib, expectedRange] of Object.entries(compatInfo)) {
        const installedVersionRange = dependencies[lib];
        if (!installedVersionRange) {
            issues.push(`- ${lib}: Expected ${expectedRange} for Expo ${compatKeyVersion}, but package not found in dependencies.`);
            continue;
        }
        const installedMinVersion = semver.minVersion(installedVersionRange)?.version;
        if (!installedMinVersion) {
            issues.push(`- ${lib}: Could not parse installed version range "${installedVersionRange}".`);
            continue;
        }
        if (!semver.satisfies(installedMinVersion, expectedRange)) {
          issues.push(`- ${lib}: Installed version range "${installedVersionRange}" (min: ${installedMinVersion}) might not satisfy expected version ${expectedRange} for Expo ${compatKeyVersion}.`);
        } else {
            console.log(`[Tool] Compatibility check OK for ${lib}: installed range ${installedVersionRange} satisfies expected ${expectedRange}`);
        }
      }
      const report = issues.length > 0
        ? `Potential compatibility issues found for Expo SDK ${versionToCheck} (using data for ${compatKeyVersion}):\n${issues.join('\n')}\nNote: This check is based on package.json ranges and an internal compatibility map. Verify with official documentation.`
        : `Dependencies seem compatible with Expo SDK ${versionToCheck} (using data for ${compatKeyVersion}) based on available data and package.json ranges.`;
      return { content: [{ type: "text", text: report }] };
    } catch (error: any) {
      console.error(`[Tool Error] checkProjectCompatibility:`, error);
      let message = `Error analyzing compatibility: ${error.message}`;
      if (error instanceof SyntaxError) {
          message = `Error parsing package.json content: ${error.message}`;
      }
      return { content: [{ type: "text", text: message }], isError: true };
    }
  }
);


// 2. Find Upgrade Changelog Tool (Implemented)
const findUpgradeChangelogSchema = z.object({
    packageName: z.string().describe("The NPM package name."),
    fromVersion: z.string().describe("The version you are upgrading from (e.g., '1.2.0')."),
    toVersion: z.string().describe("The version you are upgrading to (e.g., '1.3.1').")
});

server.tool(
  "findUpgradeChangelog",
  findUpgradeChangelogSchema,
  "Fetches GitHub release notes between two versions for a package.",
  async ({ packageName, fromVersion, toVersion }) => {
    console.log(`[Tool] Finding upgrade changelog for ${packageName} from ${fromVersion} to ${toVersion}`);
    try {
        // 1. Get repository URL
        const pkgInfo = await fetchPackageInfo(packageName);
        if (!pkgInfo) throw new Error(`Could not fetch package info for ${packageName}.`);
        const repoUrl = getGitHubRepoUrl(pkgInfo);
        if (!repoUrl) throw new Error(`Could not determine GitHub repository URL for ${packageName}.`);
        const repoInfo = parseGitHubUrl(repoUrl);
        if (!repoInfo) throw new Error(`Could not parse owner/repo from URL: ${repoUrl}`);

        // 2. Fetch releases
        // Fetch more releases in case tags are non-sequential or have gaps
        const allReleases = await fetchGitHubReleases(repoInfo.owner, repoInfo.repo, 100);

        // 3. Filter releases based on version range using semver
        // Ensure versions are clean for comparison
        const cleanFrom = semver.clean(fromVersion);
        const cleanTo = semver.clean(toVersion);
        if (!cleanFrom || !cleanTo) {
            throw new Error(`Invalid version format for comparison: from='${fromVersion}', to='${toVersion}'.`);
        }

        const relevantReleases = allReleases.filter(r => {
            const releaseVersion = semver.clean(r.tag_name);
            // Check if tag is a valid semver and within the range (fromVersion < tag <= toVersion)
            return releaseVersion &&
                   semver.valid(releaseVersion) &&
                   semver.gt(releaseVersion, cleanFrom) &&
                   semver.lte(releaseVersion, cleanTo);
        }).sort((a, b) => semver.compare(semver.clean(a.tag_name)!, semver.clean(b.tag_name)!)); // Sort chronologically

        // 4. Format output
        if (relevantReleases.length === 0) {
             return { content: [{ type: "text", text: `No GitHub releases found for ${packageName} between versions ${fromVersion} and ${toVersion}. Check the repository manually.` }] };
        }

        const formattedOutput = relevantReleases.map(r =>
            `## [${r.tag_name}](${r.html_url}) (${r.published_at ? new Date(r.published_at).toLocaleDateString() : 'N/A'})${r.name ? ` - ${r.name}` : ''}\n\n${r.body || '*No release body provided.*'}`
        ).join('

---

');

        return { content: [{ type: "text", text: `**Changelog for ${packageName} (${fromVersion} -> ${toVersion})**:

${formattedOutput}` }] };

    } catch (error: any) {
      console.error(`[Tool Error] findUpgradeChangelog for ${packageName}:`, error);
      return { content: [{ type: "text", text: `Error finding upgrade changelog: ${error.message}` }], isError: true };
    }
  }
);


// 3. Check for Deprecations/Breaking Changes Tool (Implemented)
const checkBreakingChangesSchema = z.object({
    packageName: z.string().describe("The NPM package name."),
    fromVersion: z.string().describe("The version you are upgrading from."),
    toVersion: z.string().describe("The version you are upgrading to."),
    // changelogContent: z.string().optional().describe("Full changelog text (if already fetched).") // Option removed, tool will fetch
});

const breakingKeywords = /(breaking change|breaking|deprecated|deprecation|removed|removal|migrate|migration)/i;

server.tool(
  "checkBreakingChanges",
  checkBreakingChangesSchema,
  "Scans GitHub release notes between versions for keywords indicating breaking changes or deprecations.",
  async ({ packageName, fromVersion, toVersion }) => {
    console.log(`[Tool] Checking breaking changes for ${packageName} from ${fromVersion} to ${toVersion}`);
     try {
        // 1. Get repository URL (reuse logic/helpers)
        const pkgInfo = await fetchPackageInfo(packageName);
        if (!pkgInfo) throw new Error(`Could not fetch package info for ${packageName}.`);
        const repoUrl = getGitHubRepoUrl(pkgInfo);
        if (!repoUrl) throw new Error(`Could not determine GitHub repository URL for ${packageName}.`);
        const repoInfo = parseGitHubUrl(repoUrl);
        if (!repoInfo) throw new Error(`Could not parse owner/repo from URL: ${repoUrl}`);

        // 2. Fetch relevant releases (reuse logic/helpers)
        const allReleases = await fetchGitHubReleases(repoInfo.owner, repoInfo.repo, 100);
        const cleanFrom = semver.clean(fromVersion);
        const cleanTo = semver.clean(toVersion);
        if (!cleanFrom || !cleanTo) {
            throw new Error(`Invalid version format for comparison: from='${fromVersion}', to='${toVersion}'.`);
        }
        const relevantReleases = allReleases.filter(r => {
            const releaseVersion = semver.clean(r.tag_name);
            return releaseVersion && semver.valid(releaseVersion) && semver.gt(releaseVersion, cleanFrom) && semver.lte(releaseVersion, cleanTo);
        }).sort((a, b) => semver.compare(semver.clean(a.tag_name)!, semver.clean(b.tag_name)!));

        if (relevantReleases.length === 0) {
             return { content: [{ type: "text", text: `No GitHub releases found for ${packageName} between versions ${fromVersion} and ${toVersion} to scan for breaking changes.` }] };
        }

        // 3. Scan release bodies for keywords
        const findings: string[] = [];
        relevantReleases.forEach(release => {
            if (release.body) {
                const lines = release.body.split('\n');
                lines.forEach((line, index) => {
                    if (breakingKeywords.test(line)) {
                        // Find the start of the relevant section (e.g., heading or bullet point)
                        let contextStart = index;
                        while(contextStart > 0 && !lines[contextStart].match(/^#{1,4} /) && !lines[contextStart].match(/^\* /) && !lines[contextStart].match(/^- /)) {
                            contextStart--;
                        }
                        const contextEnd = Math.min(index + 3, lines.length); // Include a few lines after
                        const snippet = lines.slice(contextStart, contextEnd).join('\n');

                        findings.push(`**Release ${release.tag_name}:**\n...\n${snippet}\n...\n*Full note: ${release.html_url}*`);
                    }
                });
            }
        });

        // 4. Format results
        if (findings.length === 0) {
            return { content: [{ type: "text", text: `No obvious breaking changes or deprecations found based on keyword search in release notes for ${packageName} (${fromVersion} -> ${toVersion}). Manual review is still recommended.` }] };
        } else {
            return { content: [{ type: "text", text: `**Potential Breaking Changes/Deprecations Found for ${packageName} (${fromVersion} -> ${toVersion})**:

${findings.join('

---

')}

*Note: This is based on a keyword search and may include false positives or miss complex changes. Always review the full changelog.*` }] };
        }

    } catch (error: any) {
      console.error(`[Tool Error] checkBreakingChanges for ${packageName}:`, error);
      return { content: [{ type: "text", text: `Error checking breaking changes: ${error.message}` }], isError: true };
    }
  }
);


// --- Prompts --- (Unchanged)

// 1. Upgrade Helper Prompt
server.prompt(
  "assistUpgrade",
  {
      packageName: z.string().describe("The NPM package name to upgrade."),
      currentVersion: z.string().describe("The current installed version."),
      targetVersion: z.string().describe("The desired target version (e.g., 'latest', '50.0.0').")
  },
  "Generates a plan for an LLM to assist with a package upgrade using available tools and resources.",
  ({ packageName, currentVersion, targetVersion }) => ({
    messages: [{
      role: "system",
      content: {
        type: "text",
        text: `**Plan for Upgrading ${packageName} from ${currentVersion} to ${targetVersion}:**

1.  **Get Target Version Info:** Use the 'npm-package-info' resource for \`package://npm/${packageName}/version/${targetVersion === 'latest' ? '' : targetVersion}\` to confirm the exact version number (if 'latest') and get its repository URL. Note the exact target version resolved. Let's call it 'resolvedTargetVersion'.
2.  **Fetch Changelog Info:** Use the 'findUpgradeChangelog' tool with \`packageName: "${packageName}", fromVersion: "${currentVersion}", toVersion: resolvedTargetVersion\`. Review the fetched release notes.
3.  **Check for Breaking Changes:** Use the 'checkBreakingChanges' tool with the same arguments (\`packageName: "${packageName}", fromVersion: "${currentVersion}", toVersion: resolvedTargetVersion\`). Pay close attention to any reported breaking changes or deprecations.
4.  **Check Compatibility (if applicable):**
    *   If upgrading 'expo', 'react-native', or 'react', check compatibility.
    *   First, get the *new* expected compatibility requirements using the 'expo-sdk-compatibility' resource for the target Expo SDK version (if upgrading Expo, use \`compatibility://expo/sdk/${resolvedTargetVersion}\`, otherwise use the *current* project's Expo SDK version).
    *   Compare these requirements with the versions of other core packages involved in the upgrade.
    *   *(Optional Advanced)* If the user's `package.json` is available (e.g., via a previous `project-file` resource call), you could use the `checkProjectCompatibility` tool *after* hypothetically updating the package version in the JSON content to see if it introduces new issues with the *current* Expo SDK.
5.  **Summarize & Guide:** Based on the findings from the changelog and breaking changes analysis, summarize the key changes, highlight potential migration steps, and list any major risks or necessary code modifications. Advise the user on the next steps (e.g., install the package, run tests, follow migration guides).`
      }
    }]
  })
);

// 2. Project Health Check Prompt
server.prompt(
  "checkProjectHealth",
  {
      packageJsonPath: z.string().default("package.json").describe("Relative path to package.json."),
      lockfilePath: z.string().optional().describe("Relative path to package-lock.json or yarn.lock.")
  },
  "Generates a plan for an LLM to analyze project dependency health.",
  ({ packageJsonPath, lockfilePath }) => ({
    messages: [{
      role: "system",
      content: {
        type: "text",
        text: `**Plan for Project Health Check:**

1.  **Read Project Files:**
    *   Use the 'project-file' resource to read \`project://${packageJsonPath}\`. If this fails, stop and report the error.
    *   *(Optional)* If \`lockfilePath\` is provided, use 'project-file' to read \`project://${lockfilePath}\`. Note whether it was found.
2.  **Perform Compatibility Check:**
    *   Use the 'checkProjectCompatibility' tool. Provide the content of \`package.json\` read in step 1. If lockfile content was read, provide that too.
    *   Report any compatibility issues found, especially regarding the detected Expo SDK version.
3.  **Check for Outdated Major Dependencies (React Native/Expo related):**
    *   Parse the \`package.json\` content to identify key dependencies (e.g., 'expo', 'react', 'react-native', major 'expo-*' packages, '@react-navigation/native').
    *   For each key dependency, get its installed version range (from \`package.json\`) and potentially the exact locked version (if lockfile content is available). Let's call the installed version 'installedVersion'.
    *   Use the 'npm-package-info' resource (\`package://npm/{packageName}\`) to get the latest version. Let's call it 'latestVersion'.
    *   Compare 'installedVersion' with 'latestVersion' using semantic versioning. Identify packages where the installed version is significantly behind the latest (e.g., one or more major versions behind).
4.  **Summarize Findings:** Report on:
    *   The overall compatibility status from step 2.
    *   A list of key dependencies that are significantly outdated (major versions behind latest), including their installed and latest versions.
    *   Any errors encountered during the process (e.g., files not found, API errors).
    *   Provide recommendations, such as updating specific packages or reviewing compatibility notes.`
      }
    }]
  })
);


// --- Server Connection ---

async function runServer() {
    console.log("Starting MCP React Native/Expo Helper Server...");
    const transport = new StdioServerTransport();
    try {
        await server.connect(transport);
        console.log("MCP Server connected via stdio. Waiting for requests...");
        console.log("Available Resources: npm-package-info, github-changelog, expo-sdk-compatibility, project-file");
        console.log("Available Tools: checkProjectCompatibility, findUpgradeChangelog, checkBreakingChanges");
        console.log("Available Prompts: assistUpgrade, checkProjectHealth");
    } catch (error) {
        console.error("Failed to connect MCP server:", error);
        process.exit(1);
    }
}

runServer(); 