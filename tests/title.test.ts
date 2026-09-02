import { describe, expect, test } from "bun:test"
import { slugFromUrl } from "../src/discover.ts"
import { SWE_TITLE_RE } from "../src/types.ts"

describe("SWE_TITLE_RE", () => {
  test.each([
    "Software Engineer",
    "Software Engineer II",
    "Backend Engineer",
    "Back-End Developer",
    "Full Stack Engineer",
    "Full-Stack Software Engineer",
    "Frontend Engineer, Growth",
    "Platform Engineer",
    "Infrastructure Engineer",
    "Member of Technical Staff",
    "Engineer, Product",
    "Founding Engineer",
    "Forward Deployed Engineer",
    "AI Engineer",
    "Software Development Engineer II",
    "SDE II",
    "iOS Engineer",
    "Developer, Payments",
  ])("accepts %s", (t) => {
    expect(SWE_TITLE_RE.test(t)).toBe(true)
  })

  test.each([
    "Engineering Manager",
    "Hardware Engineer",
    "Electrical Engineer",
    "Mechanical Design Engineer",
    "Sales Engineer",
    "Solutions Engineer",
    "Support Engineer",
    "Software Engineer in Test",
    "QA Engineer",
    "Data Scientist",
    "Security Engineer",
    "Product Manager, Platform",
    "Network Engineer",
    "Technical Recruiter, Engineering",
    "Account Executive",
    "Signal Integrity / Power Integrity Engineer",
    "IT Systems Engineer, Mobile Client Platform",
    "UX Engineer",
    "DevOps Engineer, GovCloud",
    "Junior Reverse Engineering/Vulnerability Research Engineer",
    "Machine Learning Engineer II",
    "Cyber Full-Stack Software Engineer",
    "Talent Acquisition Partner (AI Engineering, Product, GTM Recruiter), New York / New Jersey",
    "Design Verification (DV) Engineer - 2027 Grads",
    "Developer Relations Engineer (New York, NY)",
    "Developer Advocate, Platform",
  ])("rejects %s", (t) => {
    expect(SWE_TITLE_RE.test(t)).toBe(false)
  })
})

describe("slugFromUrl", () => {
  test.each([
    ["https://job-boards.greenhouse.io/warp/jobs/4324888004", "greenhouse", "warp"],
    ["https://boards.greenhouse.io/spacex/jobs/8563110002?gh_jid=8563110002", "greenhouse", "spacex"],
    ["https://job-boards.eu.greenhouse.io/sandtech/jobs/4956160101", "greenhouse", "sandtech"],
    ["https://jobs.lever.co/jobgether/3905aaa3-445f-4c9d-b9af-ace0b801a4ea", "lever", "jobgether"],
    ["https://jobs.ashbyhq.com/clera/565f5742-b53b-482f-8bfd-581f5c4b660b", "ashby", "clera"],
  ])("%s → %s/%s", (url, ats, slug) => {
    expect(slugFromUrl(url)).toMatchObject({ ats, slug })
  })
  test("career sites with gh_jid are not recoverable", () => {
    expect(slugFromUrl("https://stripe.com/jobs/search?gh_jid=7737237")).toBeNull()
    expect(slugFromUrl("https://www.linkedin.com/jobs/view/4460683119")).toBeNull()
  })
})
