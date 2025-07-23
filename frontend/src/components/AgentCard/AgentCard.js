import './AgentCard.css';

const imgPerson = "http://localhost:3845/assets/627d492e7c95cfbccc4574266f4dce2d0ee267c5.svg";

function AgentCard({ agent, onClick }) {
  return (
    <div className="agent-card" onClick={() => onClick && onClick(agent)}>
      <div className="agent-info">
        <div className="agent-avatar">
          <img src={imgPerson} alt="" className="avatar-icon" />
          <img src={agent.avatar} alt="" className="avatar-bg" />
        </div>
        <div className="agent-details">
          <h3 className="agent-name">{agent.name}</h3>
          <p className="agent-contact">Contact ID: {agent.contactId}</p>
          <p className="agent-program">Program: {Array.isArray(agent.program) ? agent.program.join(', ') : agent.program || agent.specialization}</p>
          <p className="agent-cases">Total Cases: {agent.totalCases}</p>
        </div>
      </div>
    </div>
  );
}

export default AgentCard;