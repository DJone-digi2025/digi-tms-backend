import supabase from "../db/supabaseClient.js"

const bufferRules = {
  reel: { design: 3, publish: 1 },
  post: { design: 3, publish: 1 },
  carousel: { design: 3, publish: 1 },
  bday: { design: 2, publish: 1}
}

// get all clients
export async function getClients() {
  const { data, error } = await supabase
    .from("clients")
    .select("*")

  if (error) {
    throw new Error(error.message)
  }

  return data
}

// get all team members
export async function getTeamMembers() {
  const { data, error } = await supabase
    .from("team_members")
    .select("*")

  if (error) {
    throw new Error(error.message)
  }

  return data
}

// find eligible designers based on rule
export function getEligibleDesigners(rule, contentType, teamMembers) {

  // remove blocked designers
  const todayStr = new Date().toISOString().split("T")[0];

const activeMembers = teamMembers.filter(m => {
  const isOnLeave =
    m.leave_start_date &&
    m.leave_end_date &&
    todayStr >= m.leave_start_date &&
    todayStr <= m.leave_end_date;

  return !m.is_blocked && !isOnLeave;
});

  if (!rule) return []

  // skip task
  if (rule.toLowerCase() === "none") {
    return []
  }

  // auto assign based on skill
  if (rule.toLowerCase() === "auto") {
    return activeMembers.filter(member =>
      member.role?.toLowerCase() === "designer" &&
      member.skill &&
      member.skill.includes(contentType)
    )
  }

  // specific designers
  const names = rule.split(",").map(n => n.trim().toLowerCase())

  return activeMembers.filter(member =>
    names.includes(member.name.toLowerCase())
  )
}

// choose designer with lowest workload for the publish date
export async function pickDesigner(eligibleDesigners) {

  if (eligibleDesigners.length === 0) {
    return null
  }

  let chosen = null
  let minLoad = Infinity

  for (const designer of eligibleDesigners) {

    const { count, error } = await supabase
      .from("tasks")
      .select("*", { count: "exact", head: true })
      .eq("team_member_id", designer.id)
      .neq("status", "COMPLETED")

    if (error) {
      throw new Error(error.message)
    }

    const workload = count || 0

    if (workload < minLoad) {
      minLoad = workload
      chosen = designer
    }

  }

  return chosen
}

// create task in database
export async function createTask(taskData) {

  const { data, error } = await supabase
    .from("tasks")
    .insert([taskData])
    .select()

  if (error) {
    throw new Error(error.message)
  }

  return data
}

export async function generateTasksFromRow(row, clients, teamMembers) {

  const {
    client_name,
    publish_date,
    content_type,
    count
  } = row

  const publishDate = new Date(publish_date)

  const type = content_type.toLowerCase().trim()
  const designBuffer = bufferRules[type]?.design

  if (!designBuffer) {
    console.log("Invalid content type:", content_type)
    return
  }

  const assignDate = new Date(publishDate)
  assignDate.setDate(assignDate.getDate() - designBuffer)

  const formattedAssignDate = assignDate.toISOString().split("T")[0]

  // find client configuration
  const client = clients.find(
    c => client_name.toLowerCase().includes(c.client_name.toLowerCase())
  )

  // 🔥 MAP STRATEGIST NAME → ID
const strategistMember = teamMembers.find(
  m => m.name.trim().toLowerCase() === client?.strategist?.trim().toLowerCase()
);

console.log("CLIENT:", client_name);
console.log("STRATEGIST NAME:", client?.strategist);
console.log("FOUND STRATEGIST ID:", strategistMember?.id);

  if (!client) {
    console.log("Client not found:", client_name)
    return
  }

  // get rule column
  let rule = null

  if (type === "reel") rule = client.reel_designers
  if (type === "post") rule = client.post_designers
  if (type === "carousel") rule = client.carousel_designers
  if (type === "bday") rule = client.bday_designers

  const eligible = getEligibleDesigners(rule, type, teamMembers)

  if (eligible.length === 0) {
    console.log("Skipping task (NONE rule)")
    return
  }

  for (let i = 1; i <= count; i++) {

    const planFilename = `${client_name.toLowerCase().replace(/\s+/g,"")}_${type}_${publish_date}_${i}`

    // 🔥 DUPLICATE CHECK FIRST
    const { data: existing, error } = await supabase
      .from("tasks")
      .select("id")
      .eq("plan_filename", planFilename)
      .limit(1)

    if (error) {
      console.error("Duplicate check error:", error.message)
      continue
    }

    if (existing && existing.length > 0) {
      console.log("Skipping duplicate task:", planFilename)
      continue
    }

    // 🔥 ONLY NOW pick designer
    const designer = await pickDesigner(eligible)

    if (!designer) {
      console.log("No designer available")
      continue
    }

    // ===== TASK CODE GENERATION =====
    const datePart = publish_date.slice(5).replace("-", ""); // MMDD

    const clientCode = client_name
      .replace(/\s+/g, "")
      .slice(0, 3)
      .toUpperCase(); // fallback (safe)

    const taskCode = `${clientCode}-${type.toUpperCase()}-${datePart}-${String(i).padStart(2, "0")}`;

    const task = {
      client_name,
      content_type: type,
      task_category: "design",
      publish_date,
      assign_date: formattedAssignDate,
      team_member_id: designer.id,
      strategist_id: strategistMember?.id || null, 
      status: "ASSIGNED",
      priority: "normal",
      is_manual: false,
      plan_filename: planFilename,
      task_code: taskCode
    }

    await createTask(task)
  }

 }