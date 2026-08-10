/**
 * The one VPC every Sisyphus stage shares, and the three security groups that
 * decide who can reach whom inside it.
 *
 * ---------------------------------------------------------------------------
 * Two subnet tiers, for two different kinds of tenant
 * ---------------------------------------------------------------------------
 * **Public subnets, for the executor's EC2 instances.** An executor instance
 * needs outbound reach only — to the machine surface, to S3, to whatever a
 * setup bundle and an agent's own tool calls need — and never inbound. A public
 * subnet with a route to an internet gateway gives it that for free; nothing
 * about being public matters once the security group denies all inbound, which
 * `SisyphusExecutorSecurityGroup` does below.
 *
 * **Private subnets, for the platform's own Lambda functions and the
 * database.** The panel's server function and the control plane both reach
 * PostgreSQL, and reaching a private RDS instance from a Lambda means the
 * Lambda has to be inside the VPC too — at which point it loses its default
 * internet route and needs one restored, which is what the NAT instance is
 * for.
 *
 * ---------------------------------------------------------------------------
 * Why `nat: "ec2"` (fck-nat) and not a managed NAT gateway
 * ---------------------------------------------------------------------------
 * A managed NAT gateway bills continuously, by the hour and by the byte,
 * for every stage that has one. The EC2 form runs the same fck-nat AMI SST
 * documents as roughly 10x cheaper — a `t4g.nano` at a few dollars a month —
 * which is the right trade for a platform whose stages spend far more time
 * existing than actually processing a workflow.
 *
 * ---------------------------------------------------------------------------
 * The bastion, and why enabling it costs nothing extra
 * ---------------------------------------------------------------------------
 * The database has no route from outside the VPC (FR-072's `publiclyAccessible:
 * false` in `database.ts`), which is deliberate — and which also means a
 * migration run from a developer's laptop has no way in without one. `sst
 * tunnel` opens that way in, through a bastion. With `nat: "ec2"` already
 * running a NAT instance, `bastion: true` reuses it rather than launching a
 * second `t4g.nano`, so the bastion is free.
 *
 * ---------------------------------------------------------------------------
 * Three security groups, not the VPC's own default
 * ---------------------------------------------------------------------------
 * `sst.aws.Vpc`'s own default security group allows inbound from the rest of
 * the VPC's CIDR — which would let the executor's EC2 instances, the app
 * Lambdas and the database all reach each other over the network, with
 * nothing having decided that should be allowed. Nothing is ever attached to
 * that default group here; three purpose-built groups replace it:
 *
 *  - **Executor** — attached to every executor EC2 instance. All outbound, no
 *    inbound.
 *  - **App** — attached to the panel's server function and the control
 *    plane's Lambda. All outbound (it has to reach the database, Slack,
 *    Google, S3); no inbound, because nothing calls a Lambda over VPC
 *    networking.
 *  - **Database** — attached to the RDS instance. Inbound from the App group
 *    on 5432, plus the NAT instance's group so `sst tunnel` — which reaches
 *    the VPC through that same instance acting as bastion — can actually
 *    connect during a migration; without this second rule the tunnel routes
 *    traffic to the database but the security group drops it, which surfaces
 *    as a connection timeout rather than a clear refusal. An executor
 *    instance sharing this VPC's public subnets is in neither group and
 *    therefore still cannot reach the database at the network level — the
 *    network-level counterpart to `buildRunnerPolicy`'s "no database access
 *    of any kind."
 *
 * ---------------------------------------------------------------------------
 * Why this is a fixed logical name, not derived from a scope
 * ---------------------------------------------------------------------------
 * `sst.aws.Vpc`, like `sst.aws.Nextjs` in `nextjs-website.ts`, derives its own
 * physical AWS resource names from the app, the stage and this logical name —
 * a `ResourceScope` has nothing to add. The name is a constant for the same
 * reason `NEXTJS_WEBSITE_NAME` is: it is part of the Pulumi URN of an
 * already-deployed VPC, and changing it destroys and recreates one rather
 * than renaming it.
 */

/** Logical name of the shared VPC. See the note above before changing it. */
export const SISYPHUS_VPC_NAME = 'SisyphusVpc'

const POSTGRES_PORT = 5432

const ALL_OUTBOUND: aws.ec2.SecurityGroupArgs['egress'] = [
  { protocol: '-1', fromPort: 0, toPort: 0, cidrBlocks: ['0.0.0.0/0'] },
]

export interface SisyphusVpc {
  readonly vpc: sst.aws.Vpc
  /** Public subnet ids, for the executor's EC2 instances. */
  readonly publicSubnetIds: $util.Output<string[]>
  /** Private subnet ids, for VPC-attached Lambdas and the database's subnet group. */
  readonly privateSubnetIds: $util.Output<string[]>
  /** All outbound, no inbound. Attach to every executor instance. */
  readonly executorSecurityGroup: aws.ec2.SecurityGroup
  /** All outbound, no inbound. Attach to the panel's and the control plane's Lambda functions. */
  readonly appSecurityGroup: aws.ec2.SecurityGroup
  /** Inbound from the app security group and the NAT/bastion instance on 5432. Attach to the database. */
  readonly databaseSecurityGroup: aws.ec2.SecurityGroup
}

export const createSisyphusVpc = (): SisyphusVpc => {
  const vpc = new sst.aws.Vpc(SISYPHUS_VPC_NAME, {
    // More than one is the point: spot capacity is per-availability-zone (see
    // `Ec2ComputeConfiguration.subnetIds` in the control plane's compute adapter).
    az: 2,
    // fck-nat: roughly 10x cheaper than a managed NAT gateway, for the same
    // outbound route the VPC-attached Lambdas need once they're inside the VPC.
    nat: 'ec2',
    // The database has no route from outside the VPC by design (see
    // `database.ts`), so a migration run from a developer's laptop needs a way
    // in: `sst tunnel` connects through this bastion. Free — with `nat: "ec2"`
    // already set, the bastion reuses that same NAT instance rather than
    // launching a second one.
    bastion: true,
    transform: {
      // Nothing is ever attached to the VPC's own default group on purpose —
      // every resource here gets one of the three purpose-built groups below.
      securityGroup: { ingress: [] },
    },
  })

  const executorSecurityGroup = new aws.ec2.SecurityGroup('SisyphusExecutorSecurityGroup', {
    vpcId: vpc.id,
    description: 'Sisyphus executor instances: all outbound, no inbound.',
    egress: ALL_OUTBOUND,
    ingress: [],
  })

  const appSecurityGroup = new aws.ec2.SecurityGroup('SisyphusAppSecurityGroup', {
    vpcId: vpc.id,
    description: 'Sisyphus panel and control plane Lambda functions: all outbound, no inbound.',
    egress: ALL_OUTBOUND,
    ingress: [],
  })

  // The single security group `nat: "ec2"` attaches to every NAT instance — the same instance
  // `bastion: true` reuses, so this is the group `sst tunnel` connects through.
  const bastionSecurityGroupId = vpc.nodes.natInstances.apply((instances) =>
    instances[0]?.vpcSecurityGroupIds.apply((ids) => ids[0]),
  )

  const databaseSecurityGroup = new aws.ec2.SecurityGroup('SisyphusDatabaseSecurityGroup', {
    vpcId: vpc.id,
    description:
      'Sisyphus database: inbound from the app security group and the NAT/bastion instance on 5432.',
    ingress: [
      {
        protocol: 'tcp',
        fromPort: POSTGRES_PORT,
        toPort: POSTGRES_PORT,
        securityGroups: [appSecurityGroup.id, bastionSecurityGroupId],
      },
    ],
    egress: [],
  })

  return {
    vpc,
    // `vpc.publicSubnets`/`.privateSubnets` resolve to an array that still
    // holds each id as its own unresolved `Output<string>`, not a plain
    // `string[]` inside one `Output` — `$util.all` is what actually flattens
    // that into the single output every caller here expects.
    publicSubnetIds: vpc.publicSubnets.apply((ids) => $util.all(ids)),
    privateSubnetIds: vpc.privateSubnets.apply((ids) => $util.all(ids)),
    executorSecurityGroup,
    appSecurityGroup,
    databaseSecurityGroup,
  }
}
